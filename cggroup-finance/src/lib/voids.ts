// Sau khi huỷ một giao dịch tiền: gỡ nó khỏi nghiệp vụ đã dùng nó (hoá đơn NCC, đề nghị chi, kỳ lương).
// ledger.voidCashTxn gọi hàm này (import động để tránh vòng import ledger ↔ payables).
import type { Tx } from "./db";
import { recomputeBill } from "./payables";

export async function afterCashTxnVoided(tx: Tx, cashTxnId: string) {
  const bp = await tx.billPayment.findUnique({ where: { cashTxnId } });
  if (bp) await recomputeBill(tx, bp.billId);

  // Đề nghị chi đã chi bằng giao dịch này → quay về APPROVED, chi lại được.
  const exp = await tx.expense.findUnique({ where: { cashTxnId } });
  if (exp) await tx.expense.update({ where: { id: exp.id }, data: { status: "APPROVED", cashTxnId: null } });

  // Payout đã ghi bằng giao dịch này → gỡ liên kết, ghi lại được (GĐ3).
  await tx.payout.updateMany({ where: { cashTxnId }, data: { cashTxnId: null } });

  // Kỳ lương đã chi bằng giao dịch này → quay về APPROVED (kỳ CLOSED: trigger chặn, không huỷ được).
  const period = await tx.payrollPeriod.findUnique({ where: { paidCashTxnId: cashTxnId } });
  if (period) await tx.payrollPeriod.update({ where: { id: period.id }, data: { status: "APPROVED", paidAt: null, paidCashTxnId: null } });
}
