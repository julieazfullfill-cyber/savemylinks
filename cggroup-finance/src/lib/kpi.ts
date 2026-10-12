// KPI và cổng chặn thưởng doanh số — đặc tả GĐ2 mục 06.
//
// Công thức cũ:  profit = tiền về − chi phí fulfillment
// Công thức mới: profit = tiền VỀ THẬT − fulfillment − chi phí chung phân bổ
//
// Vế cuối là thứ bị bỏ qua, nên tháng 8 có người đạt 656% KPI trong khi công ty lỗ 3.475 USD.

import { divRound, rateToScaled } from "./money";

export type KpiInput = {
  /** tiền ĐÃ THỰC VỀ trong kỳ (từ payout đã đối soát), không phải đơn ghi nhận */
  cashReceivedUsd: number;
  ffCostUsd: number;
  /** chi phí chung phân bổ theo tỷ trọng doanh thu */
  overheadUsd: number;
  targetUsd: number;
};

export type KpiOutput = {
  profitUsd: number;
  targetUsd: number;
  achievedPct: number;
  overUsd: number;
};

/** Làm tròn USD về cent để cộng trừ không trôi số. */
const cents = (usd: number) => Math.round(usd * 100);

export function computeKpi(i: KpiInput): KpiOutput {
  const profitC = cents(i.cashReceivedUsd) - cents(i.ffCostUsd) - cents(i.overheadUsd);
  const targetC = cents(i.targetUsd);
  return {
    profitUsd: profitC / 100,
    targetUsd: targetC / 100,
    achievedPct: targetC > 0 ? profitC / targetC : 0,
    overUsd: (profitC - targetC) / 100,
  };
}

/**
 * Phân bổ chi phí chung cho một người theo tỷ trọng doanh thu họ mang về.
 * overheadTotal = chi phí cố định + lương bộ phận hỗ trợ + phí sàn cố định.
 */
export function allocateOverhead(cashReceivedUsd: number, companyRevenueUsd: number, overheadTotalUsd: number): number {
  if (companyRevenueUsd <= 0) return 0;
  return Math.round((cashReceivedUsd / companyRevenueUsd) * overheadTotalUsd * 100) / 100;
}

// ------------------------------------------------------------ bậc thưởng

export type BonusTier = {
  fromPct: number;
  toPct: number | null;
  ratePct: number;
  capVnd?: number | null;
};

/** Thưởng tính trên phần profit VƯỢT target, theo bậc % đạt được. */
export function computeBonus(kpi: KpiOutput, tiers: BonusTier[], usdToVnd: number | string): bigint {
  if (kpi.overUsd <= 0) return 0n;

  const pct = kpi.achievedPct * 100;
  const tier = tiers.find((t) => pct >= t.fromPct && (t.toPct === null || pct < t.toPct));
  if (!tier) return 0n;

  // cent × (VND/USD ×1e6) × (ratePct ×100) / (100 × 1e6 × 100 × 100)
  let vnd = divRound(
    BigInt(cents(kpi.overUsd)) * rateToScaled(usdToVnd) * BigInt(Math.round(tier.ratePct * 100)),
    100n * 1_000_000n * 100n * 100n,
  );
  if (tier.capVnd != null && vnd > BigInt(tier.capVnd)) vnd = BigInt(tier.capVnd);
  return vnd;
}

// -------------------------------------------------------------- cổng chặn

export type BonusGateResult = {
  payableVnd: bigint;
  heldVnd: bigint;
  reason: string | null;
};

export const HELD_REASON_LOSS = "Công ty lỗ trong kỳ — thưởng được giữ lại, cần phê duyệt vượt cấp";
export const HELD_REASON_UNKNOWN = "Chưa nhập lợi nhuận công ty của kỳ — thưởng được giữ lại";

/**
 * Hai điều kiện trước khi thưởng được chi:
 *   1. Chỉ tính trên tiền đã thực về — đã đảm bảo ở computeKpi.
 *   2. Tháng công ty lỗ thì giữ lại, cần phê duyệt vượt cấp mới chi.
 * Bổ sung so với đặc tả: chưa biết lợi nhuận kỳ (null) cũng giữ lại — không chi khi chưa chắc.
 */
export function bonusGate(
  computedBonusVnd: bigint,
  companyProfitVnd: bigint | null,
  overrideApproved = false,
): BonusGateResult {
  if (computedBonusVnd <= 0n) return { payableVnd: 0n, heldVnd: 0n, reason: null };
  if (overrideApproved || (companyProfitVnd !== null && companyProfitVnd >= 0n)) {
    return { payableVnd: computedBonusVnd, heldVnd: 0n, reason: null };
  }
  return {
    payableVnd: 0n,
    heldVnd: computedBonusVnd,
    reason: companyProfitVnd === null ? HELD_REASON_UNKNOWN : HELD_REASON_LOSS,
  };
}
