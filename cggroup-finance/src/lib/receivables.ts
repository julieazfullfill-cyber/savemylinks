// GĐ4 tuần 2: phải thu (ArInvoice), nghĩa vụ thuế (TaxObligation), tuổi nợ — đặt ở màn 4.
//   Ghi nhận phải thu:  Nợ 131 / Có accountCode (409 thu khác, 501 NCC hoàn tiền…)
//   Thu tiền:           Nợ TK tiền / Có 131 (giao dịch sổ quỹ, mỗi lần thu một ArReceipt)
//   Nộp thuế:           Nợ 204 (TNCN) | 203 (BHXH) | 608 (thuế HKD, duy trì pháp nhân, khác) / Có TK tiền
import { audit } from "./audit";
import { AGING_LABEL, agingBucket, type AgingBucket } from "./payables";
import type { Tx } from "./db";
import { createJournal } from "./journal";
import { assertBalanced, postCashTxn } from "./ledger";

export const AR_GL = "131";

export const TAX_KINDS: Record<string, { label: string; gl: string }> = {
  THUE_HKD: { label: "Thuế hộ kinh doanh", gl: "608" },
  TNCN: { label: "Thuế TNCN đã khấu trừ", gl: "204" },
  BHXH: { label: "BHXH, BHYT, BHTN", gl: "203" },
  LLC_RENEWAL: { label: "Duy trì LLC", gl: "608" },
  KHAC: { label: "Khác", gl: "608" },
};

const statusOf = (amount: bigint, paid: bigint) => (paid <= 0n ? "OPEN" : paid >= amount ? "PAID" : "PARTIAL");

// ─────────────────────────── tuổi nợ

const BUCKETS: AgingBucket[] = ["NOT_DUE", "D1_30", "D31_60", "D61_90", "D90_PLUS"];

/** Chia số còn phải thu theo số ngày quá hạn tính đến `asOf` — cùng mốc với công nợ NCC (payables.agingBucket). */
export function agingBuckets(items: { dueDate: Date; outstandingVnd: bigint }[], asOf: Date): bigint[] {
  const out = BUCKETS.map(() => 0n);
  for (const i of items) if (i.outstandingVnd > 0n) out[BUCKETS.indexOf(agingBucket(i.dueDate, asOf))] += i.outstandingVnd;
  return out;
}
export const AGING_COLUMNS = BUCKETS.map((b) => AGING_LABEL[b]);

// ─────────────────────────── phải thu

export async function createAr(
  tx: Tx,
  p: { counterparty: string; issueDate: Date; dueDate: Date; amountVnd: bigint; accountCode: string; note?: string | null; actorId: string },
) {
  if (!p.counterparty.trim()) throw new Error("Thiếu đối tượng phải thu");
  if (p.amountVnd <= 0n) throw new Error("Số tiền phải dương");
  if (p.dueDate < p.issueDate) throw new Error("Hạn thu trước ngày ghi nhận");
  const acc = await tx.account.findUnique({ where: { code: p.accountCode } });
  if (!acc || !["REVENUE", "OTHER", "COGS", "EXPENSE", "ASSET"].includes(acc.type) || acc.code === AR_GL) throw new Error("TK đối ứng không hợp lệ");
  const lines = [
    { accountCode: AR_GL, debitVnd: p.amountVnd, creditVnd: 0n },
    { accountCode: acc.code, debitVnd: 0n, creditVnd: p.amountVnd },
  ];
  assertBalanced(lines);
  const journal = await createJournal(tx, {
    data: { date: p.issueDate, memo: `Phải thu: ${p.counterparty.trim()}`, source: "AR", createdBy: p.actorId, lines: { create: lines } },
  });
  const inv = await tx.arInvoice.create({
    data: {
      counterparty: p.counterparty.trim(),
      issueDate: p.issueDate,
      dueDate: p.dueDate,
      amountVnd: p.amountVnd,
      accountCode: acc.code,
      note: p.note?.trim() || null,
      journalId: journal.id,
      createdBy: p.actorId,
    },
  });
  await audit(tx, { actorId: p.actorId, tableName: "ArInvoice", recordId: inv.id, action: "CREATE", after: inv });
  return inv;
}

export async function recomputeAr(tx: Tx, invoiceId: string) {
  const inv = await tx.arInvoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { receipts: true } });
  const live = inv.receipts.length
    ? new Set((await tx.cashTxn.findMany({ where: { id: { in: inv.receipts.map((r) => r.cashTxnId) }, voidedAt: null }, select: { id: true } })).map((t) => t.id))
    : new Set<string>();
  const paid = inv.receipts.filter((r) => live.has(r.cashTxnId)).reduce((a, r) => a + r.amountVnd, 0n);
  return tx.arInvoice.update({ where: { id: inv.id }, data: { paidVnd: paid, status: statusOf(inv.amountVnd, paid) } });
}

export async function receiveAr(tx: Tx, p: { invoiceId: string; accountId: string; date: Date; amount: bigint; actorId: string }) {
  const inv = await tx.arInvoice.findUniqueOrThrow({ where: { id: p.invoiceId } });
  if (inv.status === "PAID") throw new Error("Khoản phải thu đã thu đủ");
  const txn = await postCashTxn(tx, {
    date: p.date,
    accountId: p.accountId,
    direction: "IN",
    amount: p.amount,
    counterGl: AR_GL,
    journalSource: "AR_RECEIPT",
    description: `Thu nợ: ${inv.counterparty}`,
    actorId: p.actorId,
  });
  if (txn.amountVnd > inv.amountVnd - inv.paidVnd) throw new Error(`Số thu vượt số còn phải thu (${inv.amountVnd - inv.paidVnd} đ)`);
  await tx.arReceipt.create({ data: { invoiceId: inv.id, cashTxnId: txn.id, amountVnd: txn.amountVnd } });
  return recomputeAr(tx, inv.id);
}

// ─────────────────────────── nghĩa vụ thuế

export async function createTax(
  tx: Tx,
  p: { kind: string; periodLabel: string; dueDate: Date; amountVnd: bigint; entityId?: string | null; actorId: string },
) {
  if (!TAX_KINDS[p.kind]) throw new Error("Loại nghĩa vụ không hợp lệ");
  if (!p.periodLabel.trim()) throw new Error("Thiếu kỳ (VD 08/2026, Q3/2026)");
  if (p.amountVnd <= 0n) throw new Error("Số tiền phải dương");
  const t = await tx.taxObligation.create({
    data: { kind: p.kind, periodLabel: p.periodLabel.trim(), dueDate: p.dueDate, amountVnd: p.amountVnd, entityId: p.entityId || null, createdBy: p.actorId },
  });
  await audit(tx, { actorId: p.actorId, tableName: "TaxObligation", recordId: t.id, action: "CREATE", after: t });
  return t;
}

/** Nộp đủ một nghĩa vụ bằng một giao dịch chi. Huỷ giao dịch → nghĩa vụ mở lại (voids.ts). */
export async function payTax(tx: Tx, p: { id: string; accountId: string; date: Date; amount: bigint; actorId: string }) {
  const t = await tx.taxObligation.findUniqueOrThrow({ where: { id: p.id } });
  if (t.status === "PAID") throw new Error("Đã nộp");
  const txn = await postCashTxn(tx, {
    date: p.date,
    accountId: p.accountId,
    direction: "OUT",
    amount: p.amount,
    counterGl: TAX_KINDS[t.kind].gl,
    journalSource: "TAX_PAYMENT",
    description: `Nộp ${TAX_KINDS[t.kind].label} ${t.periodLabel}`,
    actorId: p.actorId,
  });
  const after = await tx.taxObligation.update({ where: { id: t.id }, data: { paidVnd: t.amountVnd, status: "PAID", cashTxnId: txn.id } });
  await audit(tx, { actorId: p.actorId, tableName: "TaxObligation", recordId: t.id, action: "UPDATE", before: t, after });
  return after;
}

/** Hôm nay quá hạn mà chưa nộp. */
export const isLate = (t: { dueDate: Date; status: string }, today: Date) => t.status !== "PAID" && t.dueDate < today;
