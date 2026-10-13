// Ghép đơn trong DB với hàm biên lãi thuần (margin.ts). Hoàn tiền tính như giảm giá thêm.
import type { Prisma } from "@prisma/client";
import { orderMargin, type OrderCosts, type OrderRevenue } from "./margin";

export type OrderWithCost = Prisma.OrderGetPayload<{ include: { cost: true; refunds: true } }>;

export function revenueOf(o: OrderWithCost): OrderRevenue {
  const refunded = o.refunds.reduce((a, r) => a + Number(r.amountUsd), 0);
  return {
    grossUsd: Number(o.grossUsd),
    discountUsd: Number(o.discountUsd) + refunded,
    shippingChargedUsd: Number(o.shippingChargedUsd),
    platformFeeUsd: Number(o.platformFeeUsd),
    taxUsd: Number(o.taxUsd),
  };
}

export function costsOf(o: OrderWithCost): OrderCosts {
  return {
    ffUsd: Number(o.cost?.ffCostUsd ?? 0),
    shipUsd: Number(o.cost?.shipCostUsd ?? 0),
    designUsd: Number(o.cost?.designCostUsd ?? 0),
    adsUsd: Number(o.cost?.adsCostUsd ?? 0),
    overheadUsd: Number(o.cost?.overheadUsd ?? 0),
  };
}

export const marginOf = (o: OrderWithCost) => orderMargin(revenueOf(o), costsOf(o));

export const ORDER_STATUS_VI: Record<string, string> = {
  NEW: "Mới",
  PROCESSING: "Đang xử lý",
  FULFILLED: "Đã gửi in",
  DELIVERED: "Đã giao",
  CANCELLED: "Huỷ",
  REFUNDED: "Đã hoàn tiền",
};

export const FULFILL_STATUS_VI: Record<string, string> = {
  PENDING: "Chờ",
  SUBMITTED: "Đã đặt",
  IN_PRODUCTION: "Đang sản xuất",
  SHIPPED: "Đã gửi",
  DELIVERED: "Đã giao",
  FAILED: "Lỗi",
};

export const usd = (v: number) => (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pct = (v: number) => (v * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 }) + "%";
