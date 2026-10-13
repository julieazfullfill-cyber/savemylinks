// Dự báo dòng tiền 13 tuần — đặc tả mục 06.
// Hàm thuần: mọi dữ liệu truyền vào, không đọc DB, để test được và chạy lại kịch bản tức thì.
//
// Ba điểm dễ sai (đặc tả):
//  1. Không cộng reserve vào số dư mở đầu — chỉ vào tuần có releaseOn.
//  2. Chi phí định kỳ rơi đúng tuần chứa ngày đến hạn, không chia đều.
//  3. Lưu snapshot mỗi tuần để đo độ lệch (làm ở GĐ1b tuần 5).

import { addDays, dayOfMonth, startOfWeek } from "./dates";
import { divRound, mulFactor } from "./money";

export type Scenario = {
  name: string;
  /** Hệ số doanh thu so với trung bình 3 tháng (1 = giữ nguyên, 0.8 = giảm 20%). */
  revenueFactor: number;
  /** Tỷ lệ giá vốn fulfillment trên doanh thu (0.35 = 35%). */
  ffRate: number;
};

export type RevenueChannel = {
  channel: string;
  /** Doanh thu trung bình/tháng (VND) của 3 tháng gần nhất. */
  monthlyVnd: bigint;
  /** Chu kỳ payout tính bằng ngày: Etsy 7, Amazon 14. */
  payoutEveryDays: number;
  /** Một ngày payout đã biết để neo chu kỳ. */
  anchor: Date;
};

/** Cơ cấu nhà cung cấp fulfillment — share cộng lại nên = 1. */
export type FulfillSupplier = { code: string; share: number; prepaid: boolean; creditDays: number };

export type ForecastInput = {
  startDate: Date;
  weeks?: number;
  scenario: Scenario;
  /** Tổng số dư KHẢ DỤNG mới nhất của mọi tài khoản, đã quy VND. */
  openingAvailableVnd: bigint;
  reserves: { releaseOn: Date; amountVnd: bigint }[];
  channels: RevenueChannel[];
  suppliers: FulfillSupplier[];
  /** Hoá đơn NCC còn nợ (đã trừ phần đã trả). Quá hạn → dồn vào tuần 1. */
  bills: { dueDate: Date; outstandingVnd: bigint }[];
  /** Khoản định kỳ hàng tháng rơi vào ngày dueDay. */
  recurring: { label: string; dueDay: number; amountVnd: bigint }[];
  manualItems: {
    expectedOn: Date;
    direction: "IN" | "OUT";
    amountVnd: bigint;
    confidence: number;
    recurring: "MONTHLY" | "WEEKLY" | null;
  }[];
  /**
   * GĐ3: tiền của đơn ĐÃ BÁN chưa về, theo lịch payout thật từng sàn (payout.ts projectPayouts).
   * Kênh có dữ liệu đơn thì `channels` chỉ còn tính doanh thu bán SAU ngày bắt đầu (anchor dời theo) — không đếm trùng.
   */
  pipeline?: { expectedOn: Date; amountVnd: bigint }[];
};

export type ForecastRow = {
  week: number;
  from: Date;
  to: Date;
  opening: bigint;
  reserveIn: bigint;
  pipelineIn: bigint;
  revenueIn: bigint;
  manualIn: bigint;
  billsOut: bigint;
  cogsOut: bigint;
  fixedOut: bigint;
  manualOut: bigint;
  inflow: bigint;
  outflow: bigint;
  net: bigint;
  closing: bigint;
};

const inRange = (d: Date, from: Date, to: Date) => d >= from && d <= to;
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

/** Tất cả lần xuất hiện của một khoản lặp lại trong [from, to]. */
function occurrences(first: Date, every: "MONTHLY" | "WEEKLY" | null, from: Date, to: Date): Date[] {
  if (!every) return inRange(first, from, to) ? [first] : [];
  const out: Date[] = [];
  if (every === "WEEKLY") {
    let d = first;
    while (d < from) d = addDays(d, 7);
    for (; d <= to; d = addDays(d, 7)) out.push(d);
    return out;
  }
  const day = first.getUTCDate();
  for (let y = from.getUTCFullYear(), m = from.getUTCMonth(); ; m++) {
    const d = dayOfMonth(y, m, day);
    if (d > to) break;
    if (d >= first && d >= from) out.push(d);
  }
  return out;
}

/** Số lần payout của kênh rơi vào [from, to]. */
function payoutsIn(ch: RevenueChannel, from: Date, to: Date): number {
  const step = ch.payoutEveryDays;
  let n = 0;
  let d = ch.anchor;
  const k = Math.ceil((from.getTime() - d.getTime()) / (step * 86_400_000));
  d = addDays(d, k * step);
  for (; d <= to; d = addDays(d, step)) if (d >= from) n++;
  return n;
}

export function buildForecast(input: ForecastInput): ForecastRow[] {
  const weeks = input.weeks ?? 13;
  const { scenario } = input;
  const start = startOfWeek(input.startDate);
  const ranges = Array.from({ length: weeks }, (_, w) => [addDays(start, 7 * w), addDays(start, 7 * w + 6)] as const);

  // Hệ số kịch bản → số nguyên ×1e6 để mọi phép nhân chia đều bằng BigInt, không trôi số.
  const rf = BigInt(Math.round(scenario.revenueFactor * 1_000_000));
  // Doanh số theo tuần (để tính giá vốn) tách khỏi tiền payout về (bị dồn theo chu kỳ sàn).
  const weeklySalesVnd = divRound(sum(input.channels.map((c) => c.monthlyVnd)) * 12n * rf, 52n * 1_000_000n);

  // Giá vốn: NCC trả trước → trừ ngay tuần phát sinh; công nợ N ngày → lùi floor(N/7) tuần.
  const cogsByWeek: bigint[] = Array(weeks).fill(0n);
  const mix = input.suppliers.length ? input.suppliers : [{ code: "_", share: 1, prepaid: true, creditDays: 0 }];
  const totalShare = mix.reduce((a, s) => a + s.share, 0) || 1;
  const weeklyCogs = mulFactor(weeklySalesVnd, scenario.ffRate);
  for (let w = 0; w < weeks; w++) {
    for (const s of mix) {
      const lag = s.prepaid ? 0 : Math.floor(s.creditDays / 7);
      if (w + lag < weeks) cogsByWeek[w + lag] += mulFactor(weeklyCogs, s.share / totalShare);
    }
  }

  const rows: ForecastRow[] = [];
  let opening = input.openingAvailableVnd;
  ranges.forEach(([from, to], w) => {
    // TIỀN VÀO
    const reserveIn = sum(input.reserves.filter((r) => inRange(r.releaseOn, from, to)).map((r) => r.amountVnd));
    const pipelineIn = sum((input.pipeline ?? []).filter((p) => inRange(p.expectedOn, from, to)).map((p) => p.amountVnd));
    const revenueIn = sum(
      input.channels.map((c) => {
        // Mỗi payout gom doanh thu của `payoutEveryDays` ngày: tháng × 12 × ngày / 365.
        const perPayout = divRound(c.monthlyVnd * 12n * BigInt(c.payoutEveryDays) * rf, 365n * 1_000_000n);
        return perPayout * BigInt(payoutsIn(c, from, to));
      }),
    );
    const manualIn = sum(
      input.manualItems
        .filter((i) => i.direction === "IN")
        .flatMap((i) => occurrences(i.expectedOn, i.recurring, from, to).map(() => mulFactor(i.amountVnd, i.confidence / 100))),
    );

    // TIỀN RA — chi luôn tính đủ 100% (thận trọng), chỉ tiền vào mới nhân độ chắc chắn.
    const billsOut = sum(
      input.bills
        .filter((b) => (w === 0 ? b.dueDate <= to : inRange(b.dueDate, from, to)))
        .map((b) => b.outstandingVnd),
    );
    const cogsOut = cogsByWeek[w];
    const fixedOut = sum(
      input.recurring.flatMap((r) => {
        const hits: bigint[] = [];
        for (let y = from.getUTCFullYear(), m = from.getUTCMonth(); ; m++) {
          const d = dayOfMonth(y, m, r.dueDay);
          if (d > to) break;
          if (d >= from) hits.push(r.amountVnd);
        }
        return hits;
      }),
    );
    const manualOut = sum(
      input.manualItems
        .filter((i) => i.direction === "OUT")
        .flatMap((i) => occurrences(i.expectedOn, i.recurring, from, to).map(() => i.amountVnd)),
    );

    const inflow = reserveIn + pipelineIn + revenueIn + manualIn;
    const outflow = billsOut + cogsOut + fixedOut + manualOut;
    const closing = opening + inflow - outflow;
    rows.push({
      week: w + 1, from, to, opening,
      reserveIn, pipelineIn, revenueIn, manualIn, billsOut, cogsOut, fixedOut, manualOut,
      inflow, outflow, net: inflow - outflow, closing,
    });
    opening = closing;
  });
  return rows;
}

/** Tuần đầu tiên số dư cuối kỳ xuống dưới ngưỡng — cảnh báo "số dư chạm đáy". */
export function firstWeekBelow(rows: ForecastRow[], floorVnd: bigint): ForecastRow | undefined {
  return rows.find((r) => r.closing < floorVnd);
}
