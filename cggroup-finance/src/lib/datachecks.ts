// Bộ kiểm tra lệch số liệu giữa các phân hệ — đặc tả GĐ4 mục 05.
// Bốn lỗi trong bộ Excel T4–T8 (lương lệch bảng lương, ô lương thiếu ba số 0, hai file KPI khác nhau,
// thưởng chi trong tháng lỗ) đều phải ngồi đối chiếu mới ra. Từ đây máy làm mỗi lần đóng sổ,
// và còn lỗi mức ERROR thì không cho đóng sổ.

import { formatMoney } from "./money";

export type CheckLevel = "INFO" | "WARN" | "ERROR";

export type CheckResult = {
  code: string;
  level: CheckLevel;
  title: string;
  detail: string;
  diffVnd?: bigint;
  /** Bổ sung: màn hình để sửa */
  href?: string;
};

const vnd = (v: bigint) => formatMoney(v);
const abs = (v: bigint) => (v < 0n ? -v : v);

// 1 — bảng lương vs bút toán lương trong sổ cái
export function checkPayrollVsLedger(payrollTotalVnd: bigint, ledgerSalaryVnd: bigint): CheckResult | null {
  const diff = payrollTotalVnd - ledgerSalaryVnd;
  if (abs(diff) <= 1000n) return null;
  return {
    code: "PAYROLL_LEDGER",
    level: "ERROR",
    title: "Chi phí lương trong sổ cái lệch với bảng lương",
    detail: `Bảng lương ${vnd(payrollTotalVnd)}, sổ cái ${vnd(ledgerSalaryVnd)}, lệch ${vnd(diff)}. Bút toán lương phải sinh từ kỳ lương, không được nhập tay.`,
    diffVnd: diff,
    href: "/so-cai?tk=601",
  };
}

// 2 — số dư sổ quỹ vs số dư chốt
export function checkCashVsStatement(
  accounts: { code: string; name: string; ledgerVnd: bigint; statementVnd: bigint | null }[],
): CheckResult[] {
  const out: CheckResult[] = [];
  for (const a of accounts) {
    if (a.statementVnd == null) {
      out.push({
        code: "CASH_NO_STATEMENT",
        level: "WARN",
        title: `Chưa chốt số dư: ${a.name}`,
        detail: `Tài khoản ${a.code} chưa có số dư cuối kỳ để đối chiếu với sổ quỹ.`,
        href: "/chot-so-du",
      });
      continue;
    }
    const diff = a.ledgerVnd - a.statementVnd;
    if (abs(diff) <= 1000n) continue;
    out.push({
      code: "CASH_MISMATCH",
      level: "ERROR",
      title: `Số dư lệch: ${a.name}`,
      detail: `Sổ quỹ ${vnd(a.ledgerVnd)}, số dư chốt ${vnd(a.statementVnd)}, lệch ${vnd(diff)}.`,
      diffVnd: diff,
      href: "/chot-so-du",
    });
  }
  return out;
}

// 3 — hoá đơn NCC vs tổng đơn fulfill trong kỳ
export function checkSupplierBills(
  suppliers: { name: string; billedVnd: bigint; fulfillmentVnd: bigint }[],
  tolerancePct = 0.02,
): CheckResult[] {
  const out: CheckResult[] = [];
  for (const s of suppliers) {
    if (s.fulfillmentVnd === 0n) continue;
    const diff = s.billedVnd - s.fulfillmentVnd;
    const pct = Number(abs(diff)) / Number(s.fulfillmentVnd);
    if (pct <= tolerancePct) continue;
    out.push({
      code: "SUPPLIER_BILL",
      level: pct > 0.1 ? "ERROR" : "WARN",
      title: `Hoá đơn ${s.name} lệch với đơn fulfill`,
      detail: `Hoá đơn ${vnd(s.billedVnd)}, tổng đơn fulfill ${vnd(s.fulfillmentVnd)}, lệch ${vnd(diff)} (${(pct * 100).toFixed(1)}%).`,
      diffVnd: diff,
      href: "/cong-no",
    });
  }
  return out;
}

// 4 — sai bậc độ lớn: thiếu hoặc thừa số 0
/**
 * So giá trị kỳ này với trung vị các kỳ trước. Lệch từ 50 lần trở lên gần như luôn là gõ nhầm số
 * chứ không phải biến động thật — bắt được lỗi Team 2 tháng 8: 39.250 thay vì 39.250.000.
 */
export function checkMagnitude(label: string, currentVnd: bigint, priorVnd: bigint[], factor = 50, href?: string): CheckResult | null {
  const prior = priorVnd.filter((v) => v > 0n).sort((a, b) => Number(a - b));
  if (prior.length < 2 || currentVnd <= 0n) return null;
  const median = prior[Math.floor(prior.length / 2)];
  const ratio = Number(currentVnd) / Number(median);
  if (ratio > 1 / factor && ratio < factor) return null;
  const direction = ratio < 1 ? "nhỏ hơn" : "lớn hơn";
  const times = ratio < 1 ? 1 / ratio : ratio;
  return {
    code: "MAGNITUDE",
    level: "ERROR",
    title: `${label}: giá trị lệch bậc độ lớn so với các kỳ trước`,
    detail: `Kỳ này ${vnd(currentVnd)}, trung vị các kỳ trước ${vnd(median)} — ${direction} khoảng ${Math.round(times)} lần. Kiểm tra xem có gõ thiếu hoặc thừa số 0 không.`,
    diffVnd: currentVnd - median,
    href,
  };
}

// 5 — đơn bán chưa có giá vốn
export function checkOrdersWithoutCost(totalOrders: number, ordersWithCost: number): CheckResult | null {
  const missing = totalOrders - ordersWithCost;
  if (missing <= 0) return null;
  const pct = missing / Math.max(1, totalOrders);
  return {
    code: "ORDER_NO_COST",
    level: pct > 0.05 ? "ERROR" : "WARN",
    title: `${missing} đơn chưa có giá vốn`,
    detail: `${missing}/${totalOrders} đơn (${(pct * 100).toFixed(1)}%) chưa gắn đơn fulfill. Biên lãi và giá vốn sẽ thiếu đúng phần này.`,
    href: "/don-hang?loc=chua-ghep",
  };
}

// 6 — thưởng chi trong tháng lỗ
export function checkBonusInLossMonth(netProfitVnd: bigint, bonusPaidVnd: bigint): CheckResult | null {
  if (netProfitVnd >= 0n || bonusPaidVnd <= 0n) return null;
  return {
    code: "BONUS_IN_LOSS",
    level: "WARN",
    title: "Đã chi thưởng trong tháng công ty lỗ",
    detail: `Lợi nhuận kỳ ${vnd(netProfitVnd)} nhưng vẫn chi ${vnd(bonusPaidVnd)} tiền thưởng. Kiểm tra xem có phê duyệt vượt cấp không.`,
    diffVnd: bonusPaidVnd,
    href: "/ky-luong",
  };
}

// 7 — bút toán không cân
export function checkTrialBalanced(diffVnd: bigint): CheckResult | null {
  if (diffVnd === 0n) return null;
  return {
    code: "TRIAL_UNBALANCED",
    level: "ERROR",
    title: "Bảng cân đối thử không cân",
    detail: `Tổng nợ trừ tổng có lệch ${vnd(diffVnd)}. Có bút toán bị hỏng — kiểm tra các bút toán nhập tay gần nhất.`,
    diffVnd,
    href: "/so-cai",
  };
}

export type DataCheckInput = {
  /** null = tháng không có kỳ lương → bỏ qua */
  payrollTotalVnd: bigint | null;
  ledgerSalaryVnd: bigint;
  cashAccounts: { code: string; name: string; ledgerVnd: bigint; statementVnd: bigint | null }[];
  suppliers: { name: string; billedVnd: bigint; fulfillmentVnd: bigint }[];
  magnitudeChecks: { label: string; currentVnd: bigint; priorVnd: bigint[]; href?: string }[];
  totalOrders: number;
  ordersWithCost: number;
  netProfitVnd: bigint;
  bonusPaidVnd: bigint;
  trialDiffVnd: bigint;
};

const RANK: Record<CheckLevel, number> = { ERROR: 0, WARN: 1, INFO: 2 };

export function runDataChecks(i: DataCheckInput): CheckResult[] {
  const list: (CheckResult | null)[] = [
    checkTrialBalanced(i.trialDiffVnd),
    i.payrollTotalVnd === null ? null : checkPayrollVsLedger(i.payrollTotalVnd, i.ledgerSalaryVnd),
    ...checkCashVsStatement(i.cashAccounts),
    ...checkSupplierBills(i.suppliers),
    ...i.magnitudeChecks.map((m) => checkMagnitude(m.label, m.currentVnd, m.priorVnd, 50, m.href)),
    checkOrdersWithoutCost(i.totalOrders, i.ordersWithCost),
    checkBonusInLossMonth(i.netProfitVnd, i.bonusPaidVnd),
  ];
  return list.filter((c): c is CheckResult => c !== null).sort((a, b) => RANK[a.level] - RANK[b.level]);
}

/** Còn lỗi ERROR thì không cho đóng sổ. */
export function blocksClosing(results: CheckResult[]): boolean {
  return results.some((r) => r.level === "ERROR");
}
