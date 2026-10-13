// Màn hình 3 — Chi phí & duyệt chi.
//   DRAFT   : đề nghị chi (ai cũng tạo được)
//   APPROVED: Giám đốc/Admin duyệt → ghi nhận chi phí Nợ TK hạng mục / Có 201 (phát sinh, chưa trả)
//   PAID    : Kế toán chi tiền → giao dịch tiền Nợ 201 / Có TK tiền; chênh tỷ giá vào 701
//   REJECTED: từ chối, kèm lý do
// Khoản chi trả ngay không cần duyệt thì nhập thẳng ở Sổ quỹ với hạng mục.
import { createJournal } from "./journal";
import type { Role } from "@prisma/client";
import { audit } from "./audit";
import { dayOfMonth } from "./dates";
import type { Tx } from "./db";
import { assertBalanced, lookupFxRate, postCashTxn, type LineDraft } from "./ledger";
import { toVnd, type Currency } from "./money";
import { FX_DIFF_GL, PAYABLE_GL } from "./payables";

export type ExpenseInput = {
  date: Date;
  categoryId: string;
  supplierId?: string | null;
  amount: bigint;
  currency: Currency;
  fxRate?: string | null;
  description: string;
  requestedBy: string;
};

export async function createExpense(tx: Tx, i: ExpenseInput) {
  if (i.amount <= 0n) throw new Error("Số tiền phải lớn hơn 0");
  const cat = await tx.expenseCategory.findUniqueOrThrow({ where: { id: i.categoryId } });
  if (!cat.active) throw new Error(`Hạng mục ${cat.name} đã ngưng dùng`);
  const rate = i.currency === "VND" ? "1" : i.fxRate?.trim() || (await lookupFxRate(tx, i.date, i.currency)).rate;
  const exp = await tx.expense.create({
    data: {
      date: i.date,
      categoryId: i.categoryId,
      supplierId: i.supplierId ?? null,
      amount: i.amount,
      currency: i.currency,
      amountVnd: toVnd(i.amount, i.currency, rate),
      description: i.description,
      requestedBy: i.requestedBy,
    },
  });
  await audit(tx, { actorId: i.requestedBy, tableName: "Expense", recordId: exp.id, action: "CREATE", after: exp });
  return exp;
}

export async function approveExpense(tx: Tx, p: { id: string; actorId: string; actorRole: Role }) {
  const before = await tx.expense.findUniqueOrThrow({ where: { id: p.id }, include: { category: true } });
  if (before.status !== "DRAFT") throw new Error(`Chỉ duyệt được đề nghị đang chờ (đang ${before.status})`);
  if (before.requestedBy === p.actorId && p.actorRole !== "ADMIN") throw new Error("Không tự duyệt đề nghị của chính mình");

  const lines: LineDraft[] = [
    { accountCode: before.category.accountCode, debitVnd: before.amountVnd, creditVnd: 0n },
    { accountCode: PAYABLE_GL, debitVnd: 0n, creditVnd: before.amountVnd },
  ];
  assertBalanced(lines);
  const journal = await createJournal(tx, {
    data: { date: before.date, memo: `Chi phí: ${before.description}`, source: "EXPENSE", createdBy: p.actorId, lines: { create: lines } },
  });
  const after = await tx.expense.update({
    where: { id: p.id },
    data: { status: "APPROVED", approvedBy: p.actorId, approvedAt: new Date(), journalId: journal.id },
  });
  await audit(tx, { actorId: p.actorId, tableName: "Expense", recordId: p.id, action: "UPDATE", before, after });
  return after;
}

export async function rejectExpense(tx: Tx, p: { id: string; actorId: string; reason: string }) {
  if (!p.reason.trim()) throw new Error("Cần ghi lý do từ chối");
  const before = await tx.expense.findUniqueOrThrow({ where: { id: p.id } });
  if (before.status !== "DRAFT") throw new Error("Chỉ từ chối được đề nghị đang chờ duyệt");
  const after = await tx.expense.update({ where: { id: p.id }, data: { status: "REJECTED", rejectedReason: p.reason.trim(), approvedBy: p.actorId, approvedAt: new Date() } });
  await audit(tx, { actorId: p.actorId, tableName: "Expense", recordId: p.id, action: "UPDATE", before, after });
  return after;
}

/** Chi tiền cho đề nghị đã duyệt. `amount` theo tiền của tài khoản chi; trống thì lấy đúng số đề nghị (cùng loại tiền). */
export async function payExpense(
  tx: Tx,
  p: { id: string; accountId: string; date: Date; amount?: bigint | null; fxRate?: string | null; actorId: string },
) {
  const before = await tx.expense.findUniqueOrThrow({ where: { id: p.id } });
  if (before.status !== "APPROVED") throw new Error("Chỉ chi được đề nghị đã duyệt");
  const acc = await tx.cashAccount.findUniqueOrThrow({ where: { id: p.accountId } });
  let amount = p.amount ?? null;
  if (amount === null) {
    if (acc.currency !== before.currency) throw new Error(`Tài khoản ${acc.code} là ${acc.currency}, đề nghị là ${before.currency} — nhập số tiền thực chi`);
    amount = before.amount;
  }

  const txn = await postCashTxn(tx, {
    date: p.date,
    accountId: p.accountId,
    direction: "OUT",
    amount,
    fxRate: p.fxRate,
    supplierId: before.supplierId,
    counterGl: PAYABLE_GL,
    journalSource: "EXPENSE_PAYMENT",
    description: `Chi: ${before.description}`,
    actorId: p.actorId,
  });

  // Chênh lệch quy đổi giữa lúc duyệt và lúc chi → 701, để 201 về đúng 0.
  const diff = before.amountVnd - txn.amountVnd;
  if (diff !== 0n) {
    const lines: LineDraft[] =
      diff > 0n
        ? [
            { accountCode: PAYABLE_GL, debitVnd: diff, creditVnd: 0n },
            { accountCode: FX_DIFF_GL, debitVnd: 0n, creditVnd: diff },
          ]
        : [
            { accountCode: FX_DIFF_GL, debitVnd: -diff, creditVnd: 0n },
            { accountCode: PAYABLE_GL, debitVnd: 0n, creditVnd: -diff },
          ];
    await createJournal(tx, {
      data: { date: p.date, memo: `Chênh lệch khi chi: ${before.description}`, source: "ADJUST", createdBy: p.actorId, lines: { create: lines } },
    });
  }
  const after = await tx.expense.update({ where: { id: p.id }, data: { status: "PAID", cashTxnId: txn.id } });
  await audit(tx, { actorId: p.actorId, tableName: "Expense", recordId: p.id, action: "UPDATE", before, after });
  return { expense: after, txn };
}

/**
 * Chi tiêu tháng theo hạng mục (VND): đề nghị đã duyệt/đã chi + giao dịch Sổ quỹ gắn hạng mục
 * (chi thẳng không qua duyệt). Dùng để so với ngân sách.
 */
export async function monthlySpendByCategory(tx: Tx, year: number, month: number) {
  const from = dayOfMonth(year, month - 1, 1);
  const to = dayOfMonth(year, month - 1, 31);
  const [exps, direct] = await Promise.all([
    tx.expense.groupBy({
      by: ["categoryId"],
      where: { status: { in: ["APPROVED", "PAID"] }, date: { gte: from, lte: to } },
      _sum: { amountVnd: true },
    }),
    // Giao dịch chi gắn hạng mục, không phải chi cho đề nghị (đã tính ở trên).
    tx.cashTxn.groupBy({
      by: ["categoryId"],
      where: { voidedAt: null, direction: "OUT", categoryId: { not: null }, date: { gte: from, lte: to } },
      _sum: { amountVnd: true },
    }),
  ]);
  const out = new Map<string, bigint>();
  for (const r of [...exps, ...direct]) {
    if (!r.categoryId) continue;
    out.set(r.categoryId, (out.get(r.categoryId) ?? 0n) + (r._sum.amountVnd ?? 0n));
  }
  return out;
}
