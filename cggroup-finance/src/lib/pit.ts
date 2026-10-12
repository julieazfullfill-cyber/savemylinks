// Thuế thu nhập cá nhân — biểu thuế luỹ tiến từng phần. Đặc tả GĐ2 mục 04.
//
// QUAN TRỌNG: mức giảm trừ gia cảnh và các bậc thuế do chính sách quy định và CÓ THỂ
// ĐÃ THAY ĐỔI. Các số dưới đây là giá trị KHỞI TẠO — kế toán xác nhận mức hiện hành rồi
// cập nhật qua bảng PayrollSetting (key = 'pit'), không sửa code.

export type PitBracket = {
  /** giới hạn trên của bậc, VND/tháng; null = bậc cuối */
  upToVnd: number | null;
  /** thuế suất, 0.05 = 5% */
  rate: number;
};

export type PitConfig = {
  /** giảm trừ bản thân, VND/tháng */
  personalVnd: number;
  /** giảm trừ mỗi người phụ thuộc, VND/tháng */
  dependentVnd: number;
  brackets: PitBracket[];
};

/** Giá trị khởi tạo — CẦN KẾ TOÁN XÁC NHẬN. */
export const PIT_DEFAULT: PitConfig = {
  personalVnd: 11_000_000,
  dependentVnd: 4_400_000,
  brackets: [
    { upToVnd: 5_000_000, rate: 0.05 },
    { upToVnd: 10_000_000, rate: 0.1 },
    { upToVnd: 18_000_000, rate: 0.15 },
    { upToVnd: 32_000_000, rate: 0.2 },
    { upToVnd: 52_000_000, rate: 0.25 },
    { upToVnd: 80_000_000, rate: 0.3 },
    { upToVnd: null, rate: 0.35 },
  ],
};

/**
 * Thu nhập chịu thuế = tổng thu nhập − BHXH NLĐ − các khoản miễn thuế
 *                      − giảm trừ bản thân − giảm trừ người phụ thuộc.
 * Trả về 0n nếu không dương.
 */
export function taxableIncome(
  grossVnd: bigint,
  insuranceEmpVnd: bigint,
  exemptVnd: bigint,
  dependents: number,
  cfg: PitConfig,
): bigint {
  const deduction = BigInt(cfg.personalVnd) + BigInt(cfg.dependentVnd) * BigInt(dependents);
  const t = grossVnd - insuranceEmpVnd - exemptVnd - deduction;
  return t > 0n ? t : 0n;
}

/** Thuế luỹ tiến từng phần trên thu nhập chịu thuế. Mỗi bậc làm tròn xuống đồng. */
export function calcPit(taxableVnd: bigint, cfg: PitConfig = PIT_DEFAULT): bigint {
  if (taxableVnd <= 0n) return 0n;

  let remaining = taxableVnd;
  let lower = 0n;
  let tax = 0n;

  for (const b of cfg.brackets) {
    const upper = b.upToVnd === null ? null : BigInt(b.upToVnd);
    const width = upper === null ? remaining : upper - lower;
    const slice = remaining < width ? remaining : width;
    if (slice <= 0n) break;

    // nhân trước chia sau để không mất độ chính xác
    tax += (slice * BigInt(Math.round(b.rate * 10_000))) / 10_000n;
    remaining -= slice;
    if (remaining <= 0n) break;
    if (upper !== null) lower = upper;
  }

  return tax;
}
