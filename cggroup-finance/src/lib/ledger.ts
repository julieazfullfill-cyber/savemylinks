import { Prisma } from "@prisma/client";
import { audit } from "./audit";
import type { Tx } from "./db";
import { toVnd, type Currency } from "./money";

// Mỗi giao dịch tiền sinh đúng một JournalEntry có tổng nợ = tổng có (đặc tả mục 01).
// Trigger journal_balanced ở DB là lưới an toàn thứ hai; ở đây kiểm trước để báo lỗi rõ.

/** Tài khoản đối ứng mặc định khi giao dịch không gắn hạng mục. */
export const DEFAULT_COUNTER = { IN: "409", OUT: "699" } as const;

export type LineDraft = { accountCode: string; debitVnd: bigint; creditVnd: bigint; shopId?: string | null; entityId?: string | null };

export function assertBalanced(lines: LineDraft[]): void {
  if (lines.length < 2) throw new Error("Bút toán cần ít nhất 2 dòng");
  let d = 0n;
  let c = 0n;
  for (const l of lines) {
    if (l.debitVnd < 0n || l.creditVnd < 0n) throw new Error("Số tiền bút toán không được âm");
    if ((l.debitVnd > 0n) === (l.creditVnd > 0n)) throw new Error("Mỗi dòng chỉ ghi một phía nợ hoặc có");
    d += l.debitVnd;
    c += l.creditVnd;
  }
  if (d !== c) throw new Error(`Bút toán lệch: nợ=${d} có=${c}`);
}

/** Dòng bút toán của một giao dịch tiền. Thu: Nợ TK tiền / Có đối ứng. Chi: ngược lại. */
export function cashTxnLines(p: {
  direction: "IN" | "OUT";
  amountVnd: bigint;
  cashGl: string;
  counterGl: string;
  shopId?: string | null;
  entityId?: string | null;
}): LineDraft[] {
  const dims = { shopId: p.shopId ?? null, entityId: p.entityId ?? null };
  const cash = { accountCode: p.cashGl, ...dims };
  const counter = { accountCode: p.counterGl, ...dims };
  return p.direction === "IN"
    ? [
        { ...cash, debitVnd: p.amountVnd, creditVnd: 0n },
        { ...counter, debitVnd: 0n, creditVnd: p.amountVnd },
      ]
    : [
        { ...counter, debitVnd: p.amountVnd, creditVnd: 0n },
        { ...cash, debitVnd: 0n, creditVnd: p.amountVnd },
      ];
}

export function reverseLines(lines: LineDraft[]): LineDraft[] {
  return lines.map((l) => ({ ...l, debitVnd: l.creditVnd, creditVnd: l.debitVnd }));
}

/**
 * Tỷ giá (VND cho 1 đơn vị nguyên tệ) áp cho ngày `date`: bản ghi FxRate gần nhất
 * vào hoặc trước ngày đó. Trả cả ngày của tỷ giá để UI cảnh báo khi không đúng ngày.
 */
export async function lookupFxRate(tx: Tx, date: Date, currency: Currency): Promise<{ rate: string; date: Date }> {
  if (currency === "VND") return { rate: "1", date };
  const r = await tx.fxRate.findFirst({
    where: { base: currency, quote: "VND", date: { lte: date } },
    orderBy: { date: "desc" },
  });
  if (!r) throw new Error(`Chưa có tỷ giá ${currency}/VND vào hoặc trước ngày ${date.toISOString().slice(0, 10)}`);
  return { rate: r.rate.toString(), date: r.date };
}

export type CashTxnInput = {
  date: Date;
  accountId: string;
  direction: "IN" | "OUT";
  amount: bigint; // minor unit nguyên tệ của tài khoản
  fxRate?: string | null; // bỏ trống → tra bảng FxRate
  categoryId?: string | null;
  supplierId?: string | null;
  shopId?: string | null;
  description: string;
  actorId: string;
};

/** Ghi một giao dịch tiền + bút toán + audit. Gọi bên trong prisma.$transaction. */
export async function postCashTxn(tx: Tx, input: CashTxnInput) {
  if (input.amount <= 0n) throw new Error("Số tiền phải dương — hướng thu/chi nằm ở cột direction");
  const account = await tx.cashAccount.findUniqueOrThrow({ where: { id: input.accountId } });
  if (!account.active) throw new Error(`Tài khoản ${account.code} đã ngưng dùng`);
  const currency = account.currency as Currency;

  const fxRate = currency === "VND" ? "1" : input.fxRate?.trim() || (await lookupFxRate(tx, input.date, currency)).rate;
  const amountVnd = toVnd(input.amount, currency, fxRate);
  if (amountVnd <= 0n) throw new Error("Số tiền quy đổi VND bằng 0");

  let counterGl: string = DEFAULT_COUNTER[input.direction];
  if (input.categoryId) {
    const cat = await tx.expenseCategory.findUniqueOrThrow({ where: { id: input.categoryId } });
    counterGl = cat.accountCode;
  }

  const lines = cashTxnLines({
    direction: input.direction,
    amountVnd,
    cashGl: account.glAccount,
    counterGl,
    shopId: input.shopId,
    entityId: account.entityId,
  });
  assertBalanced(lines);

  const journal = await tx.journalEntry.create({
    data: {
      date: input.date,
      memo: input.description,
      source: "CASH_TXN",
      createdBy: input.actorId,
      lines: { create: lines },
    },
  });

  const txn = await tx.cashTxn.create({
    data: {
      date: input.date,
      accountId: account.id,
      direction: input.direction,
      amount: input.amount,
      currency,
      fxRate: new Prisma.Decimal(fxRate),
      amountVnd,
      categoryId: input.categoryId ?? null,
      supplierId: input.supplierId ?? null,
      shopId: input.shopId ?? null,
      description: input.description,
      journalId: journal.id,
      createdBy: input.actorId,
    },
  });
  await audit(tx, { actorId: input.actorId, tableName: "CashTxn", recordId: txn.id, action: "CREATE", after: txn });
  return txn;
}

/**
 * Huỷ giao dịch: không xoá, không sửa đè — đánh dấu voidedAt và ghi bút toán ngược
 * (reversalOf trỏ về bút toán gốc) vào ngày `reverseOn` (mặc định ngày giao dịch gốc).
 */
export async function voidCashTxn(tx: Tx, p: { id: string; actorId: string; reason: string; reverseOn?: Date }) {
  const before = await tx.cashTxn.findUniqueOrThrow({
    where: { id: p.id },
    include: { journal: { include: { lines: true } } },
  });
  if (before.voidedAt) throw new Error("Giao dịch đã huỷ trước đó");
  if (!before.journal) throw new Error("Giao dịch không có bút toán gốc");

  const lines = reverseLines(
    before.journal.lines.map((l) => ({
      accountCode: l.accountCode,
      debitVnd: l.debitVnd,
      creditVnd: l.creditVnd,
      shopId: l.shopId,
      entityId: l.entityId,
    })),
  );
  assertBalanced(lines);
  await tx.journalEntry.create({
    data: {
      date: p.reverseOn ?? before.date,
      memo: `Huỷ: ${before.description} — ${p.reason}`,
      source: "CASH_TXN",
      reversalOf: before.journal.id,
      createdBy: p.actorId,
      lines: { create: lines },
    },
  });

  const after = await tx.cashTxn.update({
    where: { id: p.id },
    data: { voidedAt: new Date(), voidedBy: p.actorId },
  });
  const beforeRow: Partial<typeof before> = { ...before };
  delete beforeRow.journal;
  await audit(tx, { actorId: p.actorId, tableName: "CashTxn", recordId: p.id, action: "VOID", before: beforeRow, after });
  return after;
}
