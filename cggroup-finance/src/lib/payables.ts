// Màn hình 4 — Công nợ nhà cung cấp.
//   Nhận hoá đơn : Nợ TK chi phí (mặc định 501) / Có 201 Phải trả NCC.
//   Trả tiền     : giao dịch tiền Nợ 201 / Có TK tiền (BillPayment nối hoá đơn ↔ CashTxn).
//   Tất toán     : phần chênh do tỷ giá (hoá đơn USD trả ở tỷ giá khác) vào 701.
import { audit } from "./audit";
import { addDays, daysBetween } from "./dates";
import type { Tx } from "./db";
import { assertBalanced, lookupFxRate, postCashTxn, type LineDraft } from "./ledger";
import { toVnd, type Currency } from "./money";

export const PAYABLE_GL = "201";
export const FX_DIFF_GL = "701";

export type BillStatus = "OPEN" | "PARTIAL" | "PAID";

export function billStatus(amountVnd: bigint, paidVnd: bigint): BillStatus {
  if (paidVnd <= 0n) return "OPEN";
  return paidVnd >= amountVnd ? "PAID" : "PARTIAL";
}

/** Nhóm tuổi nợ theo số ngày quá hạn tại `today`. */
export type AgingBucket = "NOT_DUE" | "D1_30" | "D31_60" | "D61_90" | "D90_PLUS";
export const AGING_LABEL: Record<AgingBucket, string> = {
  NOT_DUE: "Chưa đến hạn",
  D1_30: "Quá hạn 1–30 ngày",
  D31_60: "31–60 ngày",
  D61_90: "61–90 ngày",
  D90_PLUS: "Trên 90 ngày",
};
export function agingBucket(dueDate: Date, today: Date): AgingBucket {
  const late = daysBetween(dueDate, today);
  if (late <= 0) return "NOT_DUE";
  if (late <= 30) return "D1_30";
  if (late <= 60) return "D31_60";
  if (late <= 90) return "D61_90";
  return "D90_PLUS";
}

export type BillInput = {
  supplierId: string;
  billNo?: string | null;
  issueDate: Date;
  dueDate?: Date | null; // trống → ngày hoá đơn + số ngày công nợ của NCC
  amount: bigint; // minor unit theo `currency`
  currency: Currency;
  fxRate?: string | null;
  accountCode?: string | null; // TK chi phí, mặc định 501
  description?: string | null;
  actorId: string;
};

export async function createBill(tx: Tx, i: BillInput) {
  if (i.amount <= 0n) throw new Error("Số tiền hoá đơn phải lớn hơn 0");
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: i.supplierId } });
  const dueDate = i.dueDate ?? addDays(i.issueDate, supplier.creditDays);
  if (dueDate < i.issueDate) throw new Error("Hạn trả không được trước ngày hoá đơn");
  const rate = i.currency === "VND" ? "1" : i.fxRate?.trim() || (await lookupFxRate(tx, i.issueDate, i.currency)).rate;
  const amountVnd = toVnd(i.amount, i.currency, rate);
  const accountCode = i.accountCode || "501";
  await tx.account.findUniqueOrThrow({ where: { code: accountCode } });

  const lines: LineDraft[] = [
    { accountCode, debitVnd: amountVnd, creditVnd: 0n },
    { accountCode: PAYABLE_GL, debitVnd: 0n, creditVnd: amountVnd },
  ];
  assertBalanced(lines);
  const journal = await tx.journalEntry.create({
    data: {
      date: i.issueDate,
      memo: `Hoá đơn ${supplier.name}${i.billNo ? ` số ${i.billNo}` : ""}`,
      source: "BILL",
      createdBy: i.actorId,
      lines: { create: lines },
    },
  });
  const bill = await tx.supplierBill.create({
    data: {
      supplierId: supplier.id,
      billNo: i.billNo ?? null,
      issueDate: i.issueDate,
      dueDate,
      amount: i.amount,
      currency: i.currency,
      amountVnd,
      accountCode,
      description: i.description ?? null,
      journalId: journal.id,
      createdBy: i.actorId,
    },
  });
  await audit(tx, { actorId: i.actorId, tableName: "SupplierBill", recordId: bill.id, action: "CREATE", after: bill });
  return bill;
}

/** Tính lại số đã trả từ các lần trả còn hiệu lực (giao dịch tiền chưa huỷ). */
export async function recomputeBill(tx: Tx, billId: string) {
  const bill = await tx.supplierBill.findUniqueOrThrow({ where: { id: billId } });
  const pays = await tx.billPayment.findMany({ where: { billId } });
  const live = pays.length
    ? await tx.cashTxn.findMany({ where: { id: { in: pays.map((p) => p.cashTxnId) }, voidedAt: null }, select: { id: true } })
    : [];
  const liveIds = new Set(live.map((t) => t.id));
  let paid = pays.filter((p) => liveIds.has(p.cashTxnId)).reduce((a, p) => a + p.amountVnd, 0n);
  if (paid > bill.amountVnd) paid = bill.amountVnd;
  return tx.supplierBill.update({ where: { id: billId }, data: { paidVnd: paid, status: billStatus(bill.amountVnd, paid) } });
}

export type PayInput = {
  billId: string;
  accountId: string; // trả từ tài khoản tiền nào
  date: Date;
  amount: bigint; // minor unit theo tiền của tài khoản
  fxRate?: string | null;
  /** Tất toán: coi hoá đơn đã trả đủ, phần chênh (thường do tỷ giá) ghi vào 701. */
  settle?: boolean;
  actorId: string;
};

export async function payBill(tx: Tx, i: PayInput) {
  const bill = await tx.supplierBill.findUniqueOrThrow({ where: { id: i.billId }, include: { supplier: true } });
  if (bill.status === "PAID") throw new Error("Hoá đơn đã trả đủ");
  const outstanding = bill.amountVnd - bill.paidVnd;

  const txn = await postCashTxn(tx, {
    date: i.date,
    accountId: i.accountId,
    direction: "OUT",
    amount: i.amount,
    fxRate: i.fxRate,
    supplierId: bill.supplierId,
    counterGl: PAYABLE_GL,
    journalSource: "BILL_PAYMENT",
    description: `Trả ${bill.supplier.name}${bill.billNo ? ` HĐ ${bill.billNo}` : ""}`,
    actorId: i.actorId,
  });

  if (!i.settle && txn.amountVnd > outstanding) {
    throw new Error(`Số trả (${txn.amountVnd} đ) vượt số còn nợ (${outstanding} đ) — chọn "Tất toán" nếu chênh do tỷ giá`);
  }
  const applied = txn.amountVnd < outstanding ? txn.amountVnd : outstanding;
  await tx.billPayment.create({ data: { billId: bill.id, cashTxnId: txn.id, amountVnd: applied } });

  if (i.settle) {
    // Chênh lệch giữa số còn nợ và số thực trả: trả ít hơn → lãi tỷ giá (Có 701), trả nhiều hơn → lỗ (Nợ 701).
    const diff = outstanding - txn.amountVnd;
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
      await tx.journalEntry.create({
        data: { date: i.date, memo: `Tất toán chênh lệch HĐ ${bill.billNo ?? bill.id}`, source: "ADJUST", createdBy: i.actorId, lines: { create: lines } },
      });
      if (diff > 0n) {
        // phần còn lại coi như đã tất toán
        await tx.billPayment.update({ where: { cashTxnId: txn.id }, data: { amountVnd: outstanding } });
      }
    }
  }
  const after = await recomputeBill(tx, bill.id);
  await audit(tx, { actorId: i.actorId, tableName: "SupplierBill", recordId: bill.id, action: "UPDATE", before: bill, after });
  return { bill: after, txn };
}
