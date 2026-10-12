// Động cơ tính lương — đặc tả GĐ2 mục 05. Hàm thuần, không đọc DB.
//
// Bốn ràng buộc được mã hoá (mỗi cái sửa một lỗi có thật trong bộ Excel T4–T8):
//   1. Tổng kỳ lương luôn là SUM các dòng — không có ô nào để gõ tổng.
//      (Tháng 8 công thức Excel bỏ sót 1 người, lệch 11,1 triệu.)
//   2. Kỳ lương duyệt xong tự sinh bút toán (payroll-journal.ts) — chi phí lương trong P&L
//      không bao giờ được nhập lại bằng tay. (Team 2 tháng 8 gõ 39.250 thay vì 39.250.000.)
//   3. Thưởng doanh số chỉ tính trên TIỀN ĐÃ THỰC VỀ (kpi.ts).
//   4. Tháng công ty lỗ thì thưởng bị giữ lại, cần phê duyệt vượt cấp (kpi.ts bonusGate).
//
// Khác bản đặc tả: phép nhân tỷ lệ (ngày công, BHXH) làm bằng BigInt thay vì Number,
// theo quy ước tiền của GĐ1. Kết quả self-test tháng 8 không đổi.

import { divRound } from "./money";
import { calcPit, PIT_DEFAULT, taxableIncome, type PitConfig } from "./pit";

// ----------------------------------------------------------- cấu hình

export type InsuranceConfig = {
  /** phần người lao động chịu — BHXH 8% + BHYT 1,5% + BHTN 1% */
  employeeRate: number;
  /** phần công ty chịu — BHXH 17,5% + BHYT 3% + BHTN 1% */
  companyRate: number;
};

/** Giá trị khởi tạo — CẦN KẾ TOÁN XÁC NHẬN mức hiện hành. */
export const INSURANCE_DEFAULT: InsuranceConfig = {
  employeeRate: 0.105,
  companyRate: 0.215,
};

/** Phụ cấp ăn được miễn thuế đến mức này. Cần kế toán xác nhận (PayrollSetting 'mealExemptCap'). */
export const MEAL_EXEMPT_CAP_VND = 730_000;

/** Tỷ lệ 0.105 → 1050 phần vạn, để nhân BigInt. */
const bp = (rate: number) => BigInt(Math.round(rate * 10_000));

// ----------------------------------------------------- chấm công -> ngày

export type AttendanceMark = number | "ONL";

/**
 * ONL tính là một ngày công đủ — người làm online vẫn làm việc.
 * Bảng cũ để ONL lẫn trong ô chấm công nên cột "Công" ra 0, sai.
 */
export function countWorkedDays(marks: AttendanceMark[]): number {
  return marks.reduce<number>((a, m) => a + (m === "ONL" ? 1 : m), 0);
}

// --------------------------------------------------------- tính một dòng

export type ContractSnapshot = {
  baseSalaryVnd: bigint;
  allowanceVnd: bigint;
  mealVnd: bigint;
  transportVnd: bigint;
  dutyVnd: bigint;
  insuranceSalaryVnd: bigint;
  dependents: number;
};

export type PayrollLineInput = {
  employeeId: string;
  contract: ContractSnapshot;
  workedDays: number;
  standardDays: number;
  /** thưởng doanh số ĐÃ qua cổng bonusGate() */
  salesBonusVnd: bigint;
  /** phần thưởng bị cổng giữ lại — chỉ ghi nhận, không vào thu nhập kỳ này */
  bonusHeldVnd?: bigint;
  perfPayVnd: bigint;
  penaltyVnd: bigint;
  insurance?: InsuranceConfig;
  pit?: PitConfig;
  mealExemptCapVnd?: number;
};

export type PayrollLineResult = {
  employeeId: string;
  workedDays: number;
  baseSalaryVnd: bigint;
  proratedVnd: bigint;
  allowanceVnd: bigint;
  salesBonusVnd: bigint;
  bonusHeldVnd: bigint;
  perfPayVnd: bigint;
  insuranceEmpVnd: bigint;
  insuranceCoVnd: bigint;
  pitVnd: bigint;
  penaltyVnd: bigint;
  netVnd: bigint;
};

/** Chia lương theo ngày công thực tế (tối đa bằng ngày chuẩn). Ngày công tính tới 0,01. Làm tròn về đồng. */
export function prorate(baseVnd: bigint, worked: number, standard: number): bigint {
  const s = Math.round(standard * 100);
  if (s <= 0) return 0n;
  const w = Math.min(Math.max(Math.round(worked * 100), 0), s);
  return divRound(baseVnd * BigInt(w), BigInt(s));
}

export function computePayrollLine(i: PayrollLineInput): PayrollLineResult {
  const ins = i.insurance ?? INSURANCE_DEFAULT;
  const pitCfg = i.pit ?? PIT_DEFAULT;
  const mealCap = BigInt(i.mealExemptCapVnd ?? MEAL_EXEMPT_CAP_VND);
  const c = i.contract;

  const proratedVnd = prorate(c.baseSalaryVnd, i.workedDays, i.standardDays);
  const allowanceVnd = c.allowanceVnd + c.mealVnd + c.transportVnd + c.dutyVnd;

  const insuranceEmpVnd = divRound(c.insuranceSalaryVnd * bp(ins.employeeRate), 10_000n);
  const insuranceCoVnd = divRound(c.insuranceSalaryVnd * bp(ins.companyRate), 10_000n);

  const grossVnd = proratedVnd + allowanceVnd + i.salesBonusVnd + i.perfPayVnd;

  // phụ cấp ăn miễn thuế đến một mức; phần vượt chịu thuế
  const mealExempt = c.mealVnd < mealCap ? c.mealVnd : mealCap;
  const exemptVnd = mealExempt + c.transportVnd;

  const taxable = taxableIncome(grossVnd, insuranceEmpVnd, exemptVnd, c.dependents, pitCfg);
  const pitVnd = calcPit(taxable, pitCfg);

  const netVnd = grossVnd - insuranceEmpVnd - pitVnd - i.penaltyVnd;

  return {
    employeeId: i.employeeId,
    workedDays: i.workedDays,
    baseSalaryVnd: c.baseSalaryVnd,
    proratedVnd,
    allowanceVnd,
    salesBonusVnd: i.salesBonusVnd,
    bonusHeldVnd: i.bonusHeldVnd ?? 0n,
    perfPayVnd: i.perfPayVnd,
    insuranceEmpVnd,
    insuranceCoVnd,
    pitVnd,
    penaltyVnd: i.penaltyVnd,
    netVnd,
  };
}

/** Các trường tiền mà totalPayroll cần — dòng tính từ engine hoặc đọc lại từ DB đều dùng được. */
export type PayrollAmounts = Pick<
  PayrollLineResult,
  "proratedVnd" | "allowanceVnd" | "salesBonusVnd" | "perfPayVnd" | "bonusHeldVnd" | "insuranceEmpVnd" | "insuranceCoVnd" | "pitVnd" | "penaltyVnd" | "netVnd"
>;

/**
 * Tổng kỳ lương. KHÔNG nhận tham số tổng — buộc phải cộng từ các dòng.
 * Đây là chỗ chặn đúng lỗi của bảng Excel tháng 8.
 */
export function totalPayroll(lines: PayrollAmounts[]) {
  const s = (f: (l: PayrollAmounts) => bigint) => lines.reduce((a, l) => a + f(l), 0n);
  return {
    headcount: lines.length,
    proratedVnd: s((l) => l.proratedVnd),
    allowanceVnd: s((l) => l.allowanceVnd),
    bonusVnd: s((l) => l.salesBonusVnd + l.perfPayVnd),
    bonusHeldVnd: s((l) => l.bonusHeldVnd),
    insuranceEmpVnd: s((l) => l.insuranceEmpVnd),
    insuranceCoVnd: s((l) => l.insuranceCoVnd),
    pitVnd: s((l) => l.pitVnd),
    penaltyVnd: s((l) => l.penaltyVnd),
    netVnd: s((l) => l.netVnd),
    /** chi phí công ty thực chịu = thực nhận + BHXH NLĐ + TNCN + BHXH công ty */
    companyCostVnd: s((l) => l.netVnd + l.insuranceEmpVnd + l.pitVnd + l.insuranceCoVnd),
  };
}
