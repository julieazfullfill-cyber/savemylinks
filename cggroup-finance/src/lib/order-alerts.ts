// Năm cảnh báo tự động của GĐ3 — đặc tả mục 07. Bốn trong số đó là phát hiện từ số liệu T4–T8,
// chuyển thành kiểm tra chạy mỗi lần mở màn Tổng quan thay vì chờ ai đó ngồi soi ra.
import { breakEvenRevenue, FF_RATIO_TARGET, FF_RATIO_WARN } from "./margin";

export type AlertLevel = "info" | "warn" | "error";
export type OrderAlert = { level: AlertLevel; code: string; title: string; detail: string };

const pct = (v: number, d = 1) => (v * 100).toLocaleString("vi-VN", { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";
const usd = (v: number) => "$" + Math.round(v).toLocaleString("en-US");

// 1 — tỷ lệ fulfillment trượt
export function checkFfRatio(netRevenueUsd: number, ffUsd: number, fixedCostUsd: number): OrderAlert | null {
  if (netRevenueUsd <= 0) return null;
  const ratio = ffUsd / netRevenueUsd;
  if (ratio <= FF_RATIO_WARN) return null;
  const need = breakEvenRevenue(fixedCostUsd, ratio);
  return {
    level: ratio > 0.7 ? "error" : "warn",
    code: "FF_RATIO",
    title: `Chi phí fulfillment chiếm ${pct(ratio)} doanh thu`,
    detail:
      `Ngưỡng an toàn ${pct(FF_RATIO_TARGET, 0)}. Ở mức này cần ${usd(need)}/tháng để hoà vốn, đang có ${usd(netRevenueUsd)}. ` +
      `Mỗi 1 điểm % cắt được đáng khoảng ${usd(netRevenueUsd / 100)}/tháng.`,
  };
}

// 2 — tập trung dòng tiền về
export const CONCENTRATION_LIMIT = 0.4;
export function checkConcentration(byAccount: { code: string; name: string; usd: number }[]): OrderAlert | null {
  const total = byAccount.reduce((a, b) => a + b.usd, 0);
  if (total <= 0) return null;
  const top = [...byAccount].sort((a, b) => b.usd - a.usd)[0];
  const share = top.usd / total;
  if (share <= CONCENTRATION_LIMIT) return null;
  return {
    level: share > 0.6 ? "error" : "warn",
    code: "CONCENTRATION",
    title: `${pct(share)} tiền thu đi qua một tài khoản: ${top.name}`,
    detail:
      `Ngưỡng ${pct(CONCENTRATION_LIMIT, 0)}. Một lệnh giam tài khoản này là mất ${usd(top.usd)} khả năng chi trả. ` +
      `Mở thêm cổng nhận tiền song song và rút về tài khoản công ty theo lịch cố định.`,
  };
}

// 3 — giá vốn vượt bảng giá
export const PRICE_VARIANCE_LIMIT = 0.05;
export function checkPriceVariance(
  fulfillments: { supplierName: string; sku: string | null; costUsd: number; listedCostUsd: number | null }[],
): OrderAlert[] {
  const bySupplier = new Map<string, { listed: number; actual: number; n: number }>();
  for (const f of fulfillments) {
    if (f.listedCostUsd == null || f.listedCostUsd <= 0) continue;
    const g = bySupplier.get(f.supplierName) ?? { listed: 0, actual: 0, n: 0 };
    g.listed += f.listedCostUsd;
    g.actual += f.costUsd;
    g.n += 1;
    bySupplier.set(f.supplierName, g);
  }
  const out: OrderAlert[] = [];
  for (const [name, g] of bySupplier) {
    const variance = (g.actual - g.listed) / g.listed;
    if (variance <= PRICE_VARIANCE_LIMIT) continue;
    out.push({
      level: variance > 0.12 ? "error" : "warn",
      code: "PRICE_VARIANCE",
      title: `${name}: giá thực trả cao hơn bảng giá ${pct(variance)}`,
      detail: `${g.n} đơn, bảng giá ${usd(g.listed)}, thực trả ${usd(g.actual)}, chênh ${usd(g.actual - g.listed)}. Kiểm tra bảng giá đã cũ chưa.`,
    });
  }
  return out;
}

// 4 — đơn chưa khớp đơn fulfill
export function checkUnmatchedOrders(
  orders: { externalId: string; orderedAt: Date; hasFulfillment: boolean }[],
  now = new Date(),
  hours = 48,
): OrderAlert | null {
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const stale = orders.filter((o) => !o.hasFulfillment && o.orderedAt < cutoff).sort((a, b) => a.orderedAt.getTime() - b.orderedAt.getTime());
  if (!stale.length) return null;
  return {
    level: stale.length > 20 ? "error" : "warn",
    code: "UNMATCHED_ORDER",
    title: `${stale.length} đơn chưa khớp đơn fulfill quá ${hours} giờ`,
    detail:
      `Đơn cũ nhất: ${stale[0].externalId} (${stale[0].orderedAt.toISOString().slice(0, 10)}). ` +
      `Đơn không khớp thì giá vốn không vào biên lãi, báo cáo sẽ sai.`,
  };
}

// 5 — doanh thu ghi nhận vs tiền về
export function checkCashGap(recognizedUsd: number, receivedUsd: number): OrderAlert | null {
  if (recognizedUsd <= 0) return null;
  const gap = recognizedUsd - receivedUsd;
  const share = gap / recognizedUsd;
  if (share < 0.25) return null;
  return {
    level: share > 0.4 ? "warn" : "info",
    code: "CASH_GAP",
    title: `${pct(share)} doanh thu ghi nhận chưa về tài khoản`,
    detail: `Ghi nhận ${usd(recognizedUsd)}, đã về ${usd(receivedUsd)}, còn ${usd(gap)} nằm trên sàn. Kiểm tra lịch payout và phần reserve bị giam.`,
  };
}

export type OrderAlertInput = {
  netRevenueUsd: number;
  ffUsd: number;
  fixedCostUsd: number;
  byAccount: { code: string; name: string; usd: number }[];
  fulfillments: { supplierName: string; sku: string | null; costUsd: number; listedCostUsd: number | null }[];
  orders: { externalId: string; orderedAt: Date; hasFulfillment: boolean }[];
  receivedUsd: number;
  now?: Date;
};

const RANK: Record<AlertLevel, number> = { error: 0, warn: 1, info: 2 };

export function runOrderAlerts(i: OrderAlertInput): OrderAlert[] {
  const list: (OrderAlert | null)[] = [
    checkFfRatio(i.netRevenueUsd, i.ffUsd, i.fixedCostUsd),
    checkConcentration(i.byAccount),
    ...checkPriceVariance(i.fulfillments),
    checkUnmatchedOrders(i.orders, i.now),
    checkCashGap(i.netRevenueUsd, i.receivedUsd),
  ];
  return list.filter((a): a is OrderAlert => a !== null).sort((a, b) => RANK[a.level] - RANK[b.level]);
}
