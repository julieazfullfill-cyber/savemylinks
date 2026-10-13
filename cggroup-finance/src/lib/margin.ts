// Biên lãi từng đơn — đặc tả GĐ3 mục 04.
//
// Hiện chỉ biết tỷ lệ fulfillment ở mức THÁNG: T7 = 61,7%, T8 = 71,6% — bước nhảy 10 điểm không ai
// thấy ngay vì không có chỗ nào nhìn ở mức từng đơn, từng shop.
//
// Ngưỡng: chi phí vận hành cố định ~19.800 USD/tháng, hoà vốn cần doanh thu = cố định / (1 − tỷ lệ FF).
//   FF 71,6% → cần ~69.800 USD    FF 65% → cần ~56.600 USD (đang có 57.893)
// Kéo FF về dưới 65% là đường ngắn nhất để hết lỗ, không cần bán thêm.
//
// Tiền USD ở đây là number (đã làm tròn cent ở tầng nhập); tổng hợp nhóm làm tròn về cent.

export const FF_RATIO_TARGET = 0.65;
export const FF_RATIO_WARN = 0.68;

export type OrderRevenue = {
  grossUsd: number;
  discountUsd: number;
  shippingChargedUsd: number;
  platformFeeUsd: number;
  taxUsd: number;
};

export type OrderCosts = {
  ffUsd: number;
  shipUsd: number;
  designUsd: number;
  adsUsd: number;
  /** chi phí chung phân bổ — không có vế này thì biên lãi là ảo */
  overheadUsd: number;
};

export type MarginResult = {
  netRevenueUsd: number;
  /** sau fulfillment và ship, trước chi phí chung */
  grossProfitUsd: number;
  /** sau tất cả, gồm chi phí chung phân bổ */
  netProfitUsd: number;
  grossMarginPct: number;
  netMarginPct: number;
  ffRatio: number;
};

const c2 = (v: number) => Math.round(v * 100) / 100;

export function netRevenue(r: OrderRevenue): number {
  return c2(r.grossUsd - r.discountUsd + r.shippingChargedUsd - r.platformFeeUsd - r.taxUsd);
}

export function orderMargin(r: OrderRevenue, c: OrderCosts): MarginResult {
  const net = netRevenue(r);
  const grossProfitUsd = c2(net - c.ffUsd - c.shipUsd);
  const netProfitUsd = c2(grossProfitUsd - c.designUsd - c.adsUsd - c.overheadUsd);
  return {
    netRevenueUsd: net,
    grossProfitUsd,
    netProfitUsd,
    grossMarginPct: net > 0 ? grossProfitUsd / net : 0,
    netMarginPct: net > 0 ? netProfitUsd / net : 0,
    ffRatio: net > 0 ? c.ffUsd / net : 0,
  };
}

export type MarginRow = { key: string; revenue: OrderRevenue; costs: OrderCosts };

export type GroupMargin = {
  key: string;
  orders: number;
  netRevenueUsd: number;
  ffUsd: number;
  grossProfitUsd: number;
  netProfitUsd: number;
  ffRatio: number;
  netMarginPct: number;
};

/** Gộp theo shop, theo design, hoặc theo bất kỳ key nào. Lãi nhiều nhất lên đầu. */
export function groupMargin(rows: MarginRow[]): GroupMargin[] {
  const acc = new Map<string, GroupMargin>();
  for (const row of rows) {
    const m = orderMargin(row.revenue, row.costs);
    const g = acc.get(row.key) ?? { key: row.key, orders: 0, netRevenueUsd: 0, ffUsd: 0, grossProfitUsd: 0, netProfitUsd: 0, ffRatio: 0, netMarginPct: 0 };
    g.orders += 1;
    g.netRevenueUsd = c2(g.netRevenueUsd + m.netRevenueUsd);
    g.ffUsd = c2(g.ffUsd + row.costs.ffUsd);
    g.grossProfitUsd = c2(g.grossProfitUsd + m.grossProfitUsd);
    g.netProfitUsd = c2(g.netProfitUsd + m.netProfitUsd);
    acc.set(row.key, g);
  }
  for (const g of acc.values()) {
    g.ffRatio = g.netRevenueUsd > 0 ? g.ffUsd / g.netRevenueUsd : 0;
    g.netMarginPct = g.netRevenueUsd > 0 ? g.netProfitUsd / g.netRevenueUsd : 0;
  }
  return [...acc.values()].sort((a, b) => b.netProfitUsd - a.netProfitUsd);
}

/** Doanh thu cần để hoà vốn ở một tỷ lệ FF cho trước. */
export function breakEvenRevenue(fixedCostUsd: number, ffRatio: number): number {
  if (ffRatio >= 1) return Infinity;
  return fixedCostUsd / (1 - ffRatio);
}

/**
 * Phân bổ chi phí chung cho từng đơn theo tỷ trọng doanh thu ròng trong tháng
 * (đặc tả mục 11: là lựa chọn, không phải sự thật — màn hình ghi rõ cách chia).
 */
export function allocateByRevenue(netRevenues: number[], overheadTotalUsd: number): number[] {
  const total = netRevenues.reduce((a, v) => a + Math.max(0, v), 0);
  if (total <= 0) return netRevenues.map(() => 0);
  return netRevenues.map((v) => c2((Math.max(0, v) / total) * overheadTotalUsd));
}
