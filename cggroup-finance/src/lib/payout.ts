// Đối soát payout — đặc tả GĐ3 mục 05. Nối doanh thu GHI NHẬN với tiền THẬT trong tài khoản.
//
// Đây là chỗ giải thích "có lãi trên giấy mà vẫn thiếu tiền": tiền ra cho NCC đến hạn gần như ngay khi
// đơn được fulfill, còn tiền vào phải đi qua chu kỳ payout cộng phần reserve bị sàn giam.
//
// Khác đặc tả: thêm WALMART (hệ thống có 5 kênh); ngày dùng UTC (dates.ts) như phần còn lại;
// đối soát có ngưỡng chấp nhận lệch (mặc định 1% — đặc tả mục 11: payout không bao giờ khớp 100%).

import type { ChannelCode } from "./channels";
import { addDays, daysBetween } from "./dates";

export type Channel = ChannelCode;

/** Chu kỳ trả tiền (ngày) và độ trễ xử lý của từng sàn. Đổi theo thực tế tài khoản. */
export const PAYOUT_SCHEDULE: Record<Channel, { everyDays: number; lagDays: number }> = {
  ETSY: { everyDays: 7, lagDays: 3 },
  AMAZON: { everyDays: 14, lagDays: 7 },
  WALMART: { everyDays: 14, lagDays: 2 }, // cần xác nhận theo tài khoản Walmart thật
  TIKTOK: { everyDays: 7, lagDays: 10 },
  WEBSITE: { everyDays: 2, lagDays: 2 },
};

export const RECONCILE_TOLERANCE = 0.01;

export type PayoutHeader = { id: string; grossUsd: number; feeUsd: number; netUsd: number };
export type PayoutLineIn = { orderId: string | null; amountUsd: number; kind: string };

export type ReconcileResult = {
  payoutId: string;
  /** tổng dòng có khớp đơn hàng */
  matchedUsd: number;
  /** dòng không gắn được đơn nào */
  unmatchedUsd: number;
  /** chênh lệch giữa tổng dòng và netUsd của payout */
  diffUsd: number;
  /** khớp tuyệt đối (lệch < 1 cent) */
  balanced: boolean;
  /** trong ngưỡng chấp nhận — đóng sổ được */
  withinTolerance: boolean;
  unknownOrderIds: string[];
};

const c2 = (v: number) => Math.round(v * 100) / 100;

export function reconcilePayout(
  payout: PayoutHeader,
  lines: PayoutLineIn[],
  knownOrderIds: Set<string>,
  tolerance = RECONCILE_TOLERANCE,
): ReconcileResult {
  let matchedUsd = 0;
  let unmatchedUsd = 0;
  const unknownOrderIds: string[] = [];
  for (const l of lines) {
    if (l.orderId && knownOrderIds.has(l.orderId)) matchedUsd += l.amountUsd;
    else {
      unmatchedUsd += l.amountUsd;
      if (l.orderId) unknownOrderIds.push(l.orderId);
    }
  }
  const diffUsd = c2(matchedUsd + unmatchedUsd - payout.netUsd);
  return {
    payoutId: payout.id,
    matchedUsd: c2(matchedUsd),
    unmatchedUsd: c2(unmatchedUsd),
    diffUsd,
    balanced: Math.abs(diffUsd) < 0.01,
    withinTolerance: Math.abs(diffUsd) <= Math.abs(payout.netUsd) * tolerance + 0.005,
    unknownOrderIds,
  };
}

/** Khoảng cách giữa doanh thu đã ghi nhận và tiền đã thực về trong kỳ. */
export function cashGap(recognizedUsd: number, receivedUsd: number) {
  const gapUsd = c2(recognizedUsd - receivedUsd);
  return { recognizedUsd, receivedUsd, gapUsd, gapPct: recognizedUsd > 0 ? gapUsd / recognizedUsd : 0 };
}

export type ExpectedPayout = { channel: Channel; expectedOn: Date; amountUsd: number };

/**
 * Từ doanh thu đã ghi nhận theo ngày, suy ra lịch tiền về theo chu kỳ payout của từng kênh:
 * đơn rơi vào chu kỳ kế tiếp (tính từ `from`), cộng độ trễ xử lý của sàn.
 * Dùng cho dự báo 13 tuần (thay phần ước lượng cho các đơn đã bán chưa về tiền).
 */
export function projectPayouts(
  recognized: { channel: Channel; date: Date; netUsd: number }[],
  from: Date,
  horizonDays = 91,
): ExpectedPayout[] {
  const out: ExpectedPayout[] = [];
  const limit = addDays(from, horizonDays);
  for (const r of recognized) {
    const s = PAYOUT_SCHEDULE[r.channel];
    if (!s) continue;
    const sinceStart = Math.max(0, daysBetween(from, r.date));
    const cycleEnd = Math.ceil((sinceStart + 1) / s.everyDays) * s.everyDays;
    const expectedOn = addDays(from, cycleEnd + s.lagDays);
    if (expectedOn <= limit) out.push({ channel: r.channel, expectedOn, amountUsd: r.netUsd });
  }
  return out.sort((a, b) => a.expectedOn.getTime() - b.expectedOn.getTime());
}

/** Gộp lịch tiền về thành tổng theo tuần, khớp với buildForecast. */
export function payoutsByWeek(payouts: ExpectedPayout[], weekStarts: Date[]): number[] {
  return weekStarts.map((ws, i) => {
    const we = weekStarts[i + 1] ?? addDays(ws, 7);
    return c2(payouts.filter((p) => p.expectedOn >= ws && p.expectedOn < we).reduce((a, p) => a + p.amountUsd, 0));
  });
}
