// Sinh bút toán từ kỳ lương — đặc tả GĐ2 mục 07. Chạy khi kỳ chuyển sang APPROVED.
// Sau bước này, chi phí lương trong P&L là KẾT QUẢ TRUY VẤN sổ cái — không còn ô nào để gõ tay.

import { assertBalanced, type LineDraft } from "./ledger";
import { totalPayroll, type PayrollAmounts } from "./payroll";

/**
 *   Nợ 601 Lương                 = thực nhận + BHXH NLĐ + TNCN + khấu trừ phạt
 *   Nợ 602 BHXH công ty          = phần công ty chịu
 *       Có 202 Lương phải trả    = thực nhận
 *       Có 203 BHXH phải nộp     = BHXH NLĐ + BHXH công ty
 *       Có 204 Thuế phải nộp     = TNCN
 *       Có 702 Thu chi bất thường = khấu trừ phạt
 *
 * Bổ sung so với đặc tả: khoản phạt trừ lương ghi Có 702 để bút toán vẫn cân khi có phạt
 * (đặc tả bỏ qua penalty, sẽ lệch đúng bằng số phạt). Tổng nợ = tổng có; trigger
 * journal_balanced kiểm lại lần nữa ở DB.
 */
export function buildPayrollJournal(lines: PayrollAmounts[]): LineDraft[] {
  const t = totalPayroll(lines);
  const salaryExpense = t.netVnd + t.insuranceEmpVnd + t.pitVnd + t.penaltyVnd;
  const insurancePayable = t.insuranceEmpVnd + t.insuranceCoVnd;

  const draft: LineDraft[] = [
    { accountCode: "601", debitVnd: salaryExpense, creditVnd: 0n },
    { accountCode: "602", debitVnd: t.insuranceCoVnd, creditVnd: 0n },
    { accountCode: "202", debitVnd: 0n, creditVnd: t.netVnd },
    { accountCode: "203", debitVnd: 0n, creditVnd: insurancePayable },
    { accountCode: "204", debitVnd: 0n, creditVnd: t.pitVnd },
    { accountCode: "702", debitVnd: 0n, creditVnd: t.penaltyVnd },
  ].filter((l) => l.debitVnd > 0n || l.creditVnd > 0n);

  assertBalanced(draft);
  return draft;
}
