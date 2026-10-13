// Nạp số liệu 30 ngày gần nhất cho 5 cảnh báo GĐ3 (order-alerts.ts) và đổi về dạng cảnh báo của màn 1.
import { addDays } from "./dates";
import type { Tx } from "./db";
import { runOrderAlerts } from "./order-alerts";
import { monthlyFixedCostUsd } from "./orders";
import type { Alert, Severity } from "./overview";
import { recognizedVsReceived } from "./payouts";
import { incomeByAccount } from "./shops";

const HREF: Record<string, string> = {
  FF_RATIO: "/bien-lai",
  CONCENTRATION: "/tap-trung",
  PRICE_VARIANCE: "/ncc",
  UNMATCHED_ORDER: "/don-hang?loc=chua-ghep",
  CASH_GAP: "/doi-soat",
};
const SEV: Record<string, Severity> = { error: "crit", warn: "warn", info: "info" };

export async function loadOrderAlerts(tx: Tx, today: Date): Promise<Alert[]> {
  const from = addDays(today, -29);
  const prevMonth = today.getUTCMonth() === 0 ? { y: today.getUTCFullYear() - 1, m: 12 } : { y: today.getUTCFullYear(), m: today.getUTCMonth() };
  const [orders, fulfillments, byAccount, rateRow, fixed] = await Promise.all([
    tx.order.findMany({
      where: { orderedAt: { gte: from, lte: today }, status: { notIn: ["CANCELLED", "REFUNDED"] } },
      select: { externalId: true, orderedAt: true, netUsd: true, cost: { select: { ffCostUsd: true } }, _count: { select: { fulfillments: true } } },
    }),
    tx.fulfillmentOrder.findMany({
      where: { submittedAt: { gte: from, lte: today } },
      select: { sku: true, costUsd: true, listedCostUsd: true, supplier: { select: { name: true } } },
    }),
    incomeByAccount(tx, from, today),
    tx.fxRate.findFirst({ where: { base: "USD", quote: "VND" }, orderBy: { date: "desc" } }),
    // Chi phí cố định: tháng trọn gần nhất (tháng này còn dở)
    monthlyFixedCostUsd(tx, prevMonth.y, prevMonth.m),
  ]);
  const rate = rateRow?.rate.toString() ?? null;
  const gap = await recognizedVsReceived(tx, from, today, rate);
  const toUsd = (vnd: bigint) => (rate ? Number(vnd) / Number(rate) : Number(vnd));

  const alerts = runOrderAlerts({
    netRevenueUsd: orders.reduce((a, o) => a + Number(o.netUsd), 0),
    ffUsd: orders.reduce((a, o) => a + Number(o.cost?.ffCostUsd ?? 0), 0),
    fixedCostUsd: fixed.usd,
    byAccount: byAccount.map((a) => ({ code: a.code, name: a.name, usd: toUsd(a.vnd) })),
    fulfillments: fulfillments.map((f) => ({ supplierName: f.supplier.name, sku: f.sku, costUsd: Number(f.costUsd), listedCostUsd: f.listedCostUsd === null ? null : Number(f.listedCostUsd) })),
    orders: orders.map((o) => ({ externalId: o.externalId, orderedAt: o.orderedAt, hasFulfillment: o._count.fulfillments > 0 })),
    receivedUsd: gap.receivedUsd,
    now: addDays(today, 1),
  });
  // Không có đơn nào thì doanh thu ghi nhận = 0 → bỏ CASH_GAP/FF (chưa dùng import đơn).
  return alerts.map((a) => ({ severity: SEV[a.level], title: a.title, detail: a.detail, href: HREF[a.code] ?? "/" }));
}
