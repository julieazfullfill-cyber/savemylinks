"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeOrders, parseCsv, type ImportError, type NormalizedOrder } from "@/lib/order-import";
import { importFulfillments, importOrders, recomputeOrderCosts } from "@/lib/orders";
import type { Channel } from "@/lib/payout";

export type OrderImportState = {
  mode?: "preview" | "commit";
  shop?: string;
  filename?: string;
  rowCount?: number;
  orders?: Pick<NormalizedOrder, "externalId" | "orderedAt" | "grossUsd" | "netUsd" | "items">[];
  totalNetUsd?: number;
  orderCount?: number;
  errors?: ImportError[];
  missingColumns?: string[];
  matchedColumns?: Record<string, string>;
  created?: number;
  skipped?: string[];
  error?: string;
} | null;

async function readText(form: FormData): Promise<{ text: string; filename: string }> {
  const f = form.get("file");
  if (f && typeof f !== "string" && f.size > 0) {
    if (f.size > 20 * 1024 * 1024) throw new Error("File tối đa 20MB");
    return { text: await f.text(), filename: f.name };
  }
  const text = String(form.get("data") ?? "");
  if (!text.trim()) throw new Error("Chọn file CSV hoặc dán nội dung");
  return { text, filename: "(dán trực tiếp)" };
}

/** Months (year, month) mà các đơn rơi vào — để tính lại giá vốn/phân bổ sau khi nạp. */
const monthsOf = (dates: string[]) => [...new Set(dates.map((x) => x.slice(0, 7)))].map((s) => s.split("-").map(Number) as [number, number]);

export async function runOrderImport(_prev: OrderImportState, form: FormData): Promise<OrderImportState> {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  const mode = form.get("mode") === "commit" ? "commit" : "preview";
  try {
    const shopId = String(form.get("shopId") ?? "");
    if (!shopId) throw new Error("Chọn shop");
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    const { text, filename } = await readText(form);
    const rows = parseCsv(text);
    const res = normalizeOrders(shop.channel as Channel, rows);
    const base = {
      mode,
      shop: `${shop.code} (${shop.channel})`,
      filename,
      rowCount: Math.max(0, rows.length - 1),
      orders: res.orders.slice(0, 50).map((o) => ({ externalId: o.externalId, orderedAt: o.orderedAt, grossUsd: o.grossUsd, netUsd: o.netUsd, items: o.items })),
      totalNetUsd: Math.round(res.orders.reduce((a, o) => a + o.netUsd, 0) * 100) / 100,
      errors: res.errors,
      missingColumns: res.missingColumns,
      matchedColumns: res.matchedColumns,
    } as const;
    if (mode === "preview" || !res.orders.length) return { ...base, orderCount: res.orders.length };

    const out = await prisma.$transaction(
      async (tx) => {
        const r = await importOrders(tx, { shopId, filename, orders: res.orders, rowCount: base.rowCount, errorCount: res.errors.length, actorId: me.uid });
        for (const [y, m] of monthsOf(res.orders.map((o) => o.orderedAt))) await recomputeOrderCosts(tx, y, m);
        return r;
      },
      { timeout: 180_000 },
    );
    revalidatePath("/don-hang");
    return { ...base, orderCount: res.orders.length, created: out.created, skipped: out.skipped };
  } catch (e) {
    return { mode, error: (e as Error).message };
  }
}

export type FulfillImportState = { results?: { line: number; status: string; message: string }[]; error?: string } | null;

export async function runFulfillImport(_prev: FulfillImportState, form: FormData): Promise<FulfillImportState> {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  try {
    const { text } = await readText(form);
    const results = await prisma.$transaction(
      async (tx) => {
        const r = await importFulfillments(tx, parseCsv(text), me.uid);
        // tính lại giá vốn các tháng có đơn vừa ghép
        const months = await tx.order.findMany({ where: { fulfillments: { some: {} } }, select: { orderedAt: true }, distinct: ["orderedAt"] });
        for (const [y, m] of monthsOf(months.map((o) => o.orderedAt.toISOString()))) await recomputeOrderCosts(tx, y, m);
        return r;
      },
      { timeout: 180_000 },
    );
    revalidatePath("/don-hang");
    return { results };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
