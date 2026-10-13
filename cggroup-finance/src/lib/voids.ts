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
}
