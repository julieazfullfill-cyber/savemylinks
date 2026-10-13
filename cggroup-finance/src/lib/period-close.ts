// Đóng sổ tháng — đặc tả GĐ4 mục 06 (close.ts của đặc tả; closing.ts ở đây là chốt số dư màn 5).
// Đối soát → bộ kiểm tra → phân bổ chi phí chung → kết chuyển lãi lỗ → khoá kỳ. Còn ERROR thì không khoá.

import { blocksClosing, type CheckResult } from "./datachecks";
import type { Pnl } from "./gl";

export type CloseStep = { code: string; title: string; done: boolean; blocking: boolean; detail?: string; href?: string };

export type ClosePrecondition = {
  payoutsReconciled: boolean;
  cashStatementsEntered: boolean;
  allocationsPosted: boolean;
  checks: CheckResult[];
  attendanceApproved: boolean;
  payrollClosed: boolean;
  /** Bổ sung: chi tiết cho từng bước (chưa đối soát mấy payout, tài khoản nào chưa chốt…) */
  details?: Partial<Record<"PAYOUT" | "CASH" | "ATTENDANCE" | "PAYROLL" | "ALLOC", string>>;
};

export function closeChecklist(p: ClosePrecondition): CloseStep[] {
  const errors = p.checks.filter((c) => c.level === "ERROR");
  const d = p.details ?? {};
  return [
    { code: "PAYOUT", title: "Đã đối soát toàn bộ payout trong kỳ", done: p.payoutsReconciled, blocking: true, detail: d.PAYOUT, href: "/doi-soat" },
    { code: "CASH", title: "Đã nhập số dư chốt cuối kỳ cho mọi tài khoản", done: p.cashStatementsEntered, blocking: true, detail: d.CASH, href: "/chot-so-du" },
    { code: "ATTENDANCE", title: "Chấm công đã duyệt hết", done: p.attendanceApproved, blocking: true, detail: d.ATTENDANCE, href: "/cham-cong" },
    { code: "PAYROLL", title: "Kỳ lương đã khoá", done: p.payrollClosed, blocking: true, detail: d.PAYROLL, href: "/ky-luong" },
    { code: "ALLOC", title: "Đã chạy phân bổ chi phí chung", done: p.allocationsPosted, blocking: false, detail: d.ALLOC, href: "/phan-bo" },
    {
      code: "CHECKS",
      title: "Bộ kiểm tra lệch số liệu không còn lỗi",
      done: errors.length === 0,
      blocking: true,
      detail: errors.length ? `Còn ${errors.length} lỗi mức ERROR` : undefined,
    },
  ];
}

export function canClose(steps: CloseStep[], checks: CheckResult[]): boolean {
  if (blocksClosing(checks)) return false;
  return steps.filter((s) => s.blocking).every((s) => s.done);
}

export type JournalLineDraft = { accountCode: string; debitVnd: bigint; creditVnd: bigint };

/**
 * Kết chuyển lãi lỗ về 302 Lợi nhuận giữ lại: đảo số dư các TK kết quả về 0.
 * Số dư âm (VD doanh thu bị hoàn nhiều hơn bán, TK OTHER lỗ tỷ giá) ghi ngược phía.
 */
export function buildClosingJournal(pnl: Pnl, retainedAccount = "302"): JournalLineDraft[] {
  const lines: JournalLineDraft[] = [];
  const push = (accountCode: string, debit: bigint) => {
    if (debit > 0n) lines.push({ accountCode, debitVnd: debit, creditVnd: 0n });
    else if (debit < 0n) lines.push({ accountCode, debitVnd: 0n, creditVnd: -debit });
  };
  // doanh thu, khác: số dư bên có → ghi nợ để đưa về 0
  for (const r of [...pnl.revenue, ...pnl.other]) push(r.accountCode, r.amountVnd);
  // giá vốn, chi phí: số dư bên nợ → ghi có
  for (const c of [...pnl.cogs, ...pnl.expense]) push(c.accountCode, -c.amountVnd);

  const d = lines.reduce((a, l) => a + l.debitVnd, 0n);
  const c = lines.reduce((a, l) => a + l.creditVnd, 0n);
  push(retainedAccount, c - d); // lãi: d > c → có 302; lỗ: nợ 302

  const d2 = lines.reduce((a, l) => a + l.debitVnd, 0n);
  const c2 = lines.reduce((a, l) => a + l.creditVnd, 0n);
  if (d2 !== c2) throw new Error(`Bút toán kết chuyển lệch: nợ=${d2} có=${c2}`);
  return lines;
}
