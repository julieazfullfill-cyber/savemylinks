// Màn 20–21, 23 (GĐ3): nạp đơn, đơn fulfill, hoàn tiền, giá vốn từng đơn.
// Đơn hàng là dữ liệu phân tích — không ghi sổ cái (doanh thu vào sổ khi tiền về, xem payouts.ts).
import { audit } from "./audit";
import { dayOfMonth } from "./dates";
import type { Tx } from "./db";
import { allocateByRevenue } from "./margin";
import { divRound, rateToScaled } from "./money";
import type { NormalizedOrder } from "./order-import";
import { listedPrice } from "./shops";

const c2 = (v: number) => Math.round(v * 100) / 100;

export type ImportOrdersResult = { batchId: string | null; created: number; skipped: string[] };

/**
 * Nạp đơn đã chuẩn hoá vào một shop. Một mã đơn trên một shop chỉ nạp một lần (unique shopId+externalId):
 * đơn đã có thì bỏ qua và báo lại. Mặt hàng nối Variant nếu SKU đã khai báo.
 */
export async function importOrders(
  tx: Tx,
  p: { shopId: string; filename: string; orders: NormalizedOrder[]; rowCount: number; errorCount: number; actorId: string },
): Promise<ImportOrdersResult> {
  const shop = await tx.shop.findUniqueOrThrow({ where: { id: p.shopId } });
  const existing = new Set(
    (await tx.order.findMany({ where: { shopId: shop.id, externalId: { in: p.orders.map((o) => o.externalId) } }, select: { externalId: true } })).map(
      (o) => o.externalId,
    ),
  );
  const fresh = p.orders.filter((o) => !existing.has(o.externalId));
  const skipped = p.orders.filter((o) => existing.has(o.externalId)).map((o) => o.externalId);
  if (!fresh.length) return { batchId: null, created: 0, skipped };

  const variants = new Map(
    (await tx.variant.findMany({ where: { sku: { in: fresh.flatMap((o) => o.items.map((i) => i.sku)) } } })).map((v) => [v.sku, v.id]),
  );
  const batch = await tx.importBatch.create({
    data: { channel: shop.channel, filename: p.filename, rowCount: p.rowCount, okCount: fresh.length, errorCount: p.errorCount, importedBy: p.actorId },
  });
  for (const o of fresh) {
    await tx.order.create({
      data: {
        shopId: shop.id,
        externalId: o.externalId,
        orderedAt: new Date(`${o.orderedAt}T00:00:00Z`),
        country: o.country,
        grossUsd: o.grossUsd,
        discountUsd: o.discountUsd,
        shippingChargedUsd: Math.max(0, o.shippingChargedUsd),
        platformFeeUsd: o.platformFeeUsd,
        taxUsd: o.taxUsd,
        netUsd: o.netUsd,
        importBatchId: batch.id,
        items: {
          create: o.items.map((i) => ({ sku: i.sku, qty: i.qty, unitPriceUsd: c2(i.amountUsd / i.qty), variantId: variants.get(i.sku) ?? null })),
        },
      },
    });
  }
  await audit(tx, { actorId: p.actorId, tableName: "ImportBatch", recordId: batch.id, action: "CREATE", after: { ...batch, skipped: skipped.length } });
  return { batchId: batch.id, created: fresh.length, skipped };
}

export type FulfillmentInput = {
  orderId: string;
  supplierId: string;
  sku: string | null;
  externalId: string | null;
  submittedAt: Date | null;
  costUsd: number;
  shipUsd: number;
  trackingNo: string | null;
  status?: "PENDING" | "SUBMITTED" | "IN_PRODUCTION" | "SHIPPED" | "DELIVERED" | "FAILED";
  actorId: string;
};

/** Ghép đơn bán với đơn fulfill. Giá bảng giá tại ngày đặt được lưu lại để so với giá thực trả. */
export async function addFulfillment(tx: Tx, i: FulfillmentInput) {
  if (i.costUsd < 0 || i.shipUsd < 0) throw new Error("Giá vốn không được âm");
  const order = await tx.order.findUniqueOrThrow({ where: { id: i.orderId }, include: { items: true } });
  const sku = i.sku ?? (order.items.length === 1 ? order.items[0].sku : null);
  const qty = order.items.find((x) => x.sku === sku)?.qty ?? 1;
  const unit = await listedPrice(tx, i.supplierId, sku, i.submittedAt ?? order.orderedAt);
  const f = await tx.fulfillmentOrder.create({
    data: {
      orderId: order.id,
      supplierId: i.supplierId,
      sku,
      externalId: i.externalId,
      submittedAt: i.submittedAt ?? order.orderedAt,
      status: i.status ?? "SUBMITTED",
      costUsd: c2(i.costUsd),
      shipUsd: c2(i.shipUsd),
      listedCostUsd: unit === null ? null : c2(unit * qty),
      trackingNo: i.trackingNo,
    },
  });
  if (order.status === "NEW") await tx.order.update({ where: { id: order.id }, data: { status: "PROCESSING" } });
  await audit(tx, { actorId: i.actorId, tableName: "FulfillmentOrder", recordId: f.id, action: "CREATE", after: f });
  return f;
}

export const FULFILL_COLUMNS = ["shopCode", "orderId", "supplierCode", "sku", "externalId", "submittedAt", "costUsd", "shipUsd", "trackingNo"];

/**
 * Nạp đơn fulfill từ CSV của NCC (dòng đầu là tiêu đề, tên cột như FULFILL_COLUMNS). Ghép theo mã đơn
 * trên sàn (orderId) trong shop; trùng mã đơn fulfill của cùng NCC thì bỏ qua. Lỗi từng dòng không dừng cả lô.
 */
export async function importFulfillments(tx: Tx, rows: string[][], actorId: string) {
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const missing = ["shopCode", "orderId", "supplierCode", "costUsd"].filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`Thiếu cột: ${missing.join(", ")}`);
  const [shops, suppliers] = await Promise.all([tx.shop.findMany(), tx.supplier.findMany()]);
  const shopBy = new Map(shops.map((s) => [s.code.toUpperCase(), s.id]));
  const supBy = new Map(suppliers.map((s) => [s.code.toUpperCase(), s.id]));
  const out: { line: number; status: "ok" | "skip" | "error"; message: string }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const c = Object.fromEntries(header.map((h, j) => [h, (rows[i][j] ?? "").trim()]));
    await tx.$executeRawUnsafe("SAVEPOINT ff_row");
    try {
      const shopId = shopBy.get(c.shopCode.toUpperCase());
      if (!shopId) throw new Error(`Shop "${c.shopCode}" không có`);
      const supplierId = supBy.get(c.supplierCode.toUpperCase());
      if (!supplierId) throw new Error(`NCC "${c.supplierCode}" không có`);
      const order = await tx.order.findUnique({ where: { shopId_externalId: { shopId, externalId: c.orderId } } });
      if (!order) throw new Error(`Chưa có đơn ${c.orderId} trong shop ${c.shopCode} — nạp đơn bán trước`);
      if (c.externalId && (await tx.fulfillmentOrder.findFirst({ where: { supplierId, externalId: c.externalId } }))) {
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT ff_row");
        out.push({ line: i + 1, status: "skip", message: "Đơn fulfill đã có — bỏ qua" });
        continue;
      }
      const num = (s: string) => {
        const v = Number((s || "0").replace(/[$,\s]/g, ""));
        if (!Number.isFinite(v)) throw new Error(`Số "${s}" không hợp lệ`);
        return v;
      };
      const date = c.submittedAt ? /^\d{4}-\d{2}-\d{2}/.exec(c.submittedAt)?.[0] : null;
      if (c.submittedAt && !date) throw new Error("submittedAt cần dạng YYYY-MM-DD");
      await addFulfillment(tx, {
        orderId: order.id,
        supplierId,
        sku: c.sku || null,
        externalId: c.externalId || null,
        submittedAt: date ? new Date(`${date}T00:00:00Z`) : null,
        costUsd: num(c.costUsd),
        shipUsd: num(c.shipUsd),
        trackingNo: c.trackingNo || null,
        actorId,
      });
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT ff_row");
      out.push({ line: i + 1, status: "ok", message: "Đã ghép" });
    } catch (e) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT ff_row");
      out.push({ line: i + 1, status: "error", message: (e as Error).message });
    }
  }
  return out;
}

/** Hoàn tiền: đủ toàn bộ doanh thu thì đơn chuyển REFUNDED. Biên lãi trừ phần hoàn. */
export async function addRefund(tx: Tx, p: { orderId: string; refundedAt: Date; amountUsd: number; reason: string | null; actorId: string }) {
  if (!(p.amountUsd > 0)) throw new Error("Số tiền hoàn phải lớn hơn 0");
  const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, include: { refunds: true } });
  const already = order.refunds.reduce((a, r) => a + Number(r.amountUsd), 0);
  if (already + p.amountUsd > Number(order.netUsd) + Number(order.taxUsd) + 0.005) throw new Error("Tổng hoàn vượt giá trị đơn");
  const r = await tx.refund.create({ data: { orderId: order.id, refundedAt: p.refundedAt, amountUsd: c2(p.amountUsd), reason: p.reason } });
  if (already + p.amountUsd >= Number(order.netUsd) - 0.005) await tx.order.update({ where: { id: order.id }, data: { status: "REFUNDED" } });
  await audit(tx, { actorId: p.actorId, tableName: "Refund", recordId: r.id, action: "CREATE", after: r });
  return r;
}

/**
 * Chi phí cố định tháng (USD) = tổng chi phí hoạt động (TK 60x, gồm lương, thuê VP, marketing…) trên sổ cái,
 * quy USD theo tỷ giá cuối tháng. Thay cho con số ~19.800 USD gõ tay của đặc tả.
 */
export async function monthlyFixedCostUsd(tx: Tx, year: number, month: number): Promise<{ usd: number; vnd: bigint; rate: string | null }> {
  const from = dayOfMonth(year, month - 1, 1);
  const to = dayOfMonth(year, month - 1, 31);
  const agg = await tx.journalLine.aggregate({
    where: { entry: { date: { gte: from, lte: to } }, account: { type: "EXPENSE" } },
    _sum: { debitVnd: true, creditVnd: true },
  });
  const vnd = (agg._sum.debitVnd ?? 0n) - (agg._sum.creditVnd ?? 0n);
  const r = await tx.fxRate.findFirst({ where: { base: "USD", quote: "VND", date: { lte: to } }, orderBy: { date: "desc" } });
  if (!r || vnd <= 0n) return { usd: 0, vnd, rate: r?.rate.toString() ?? null };
  return { usd: Number(divRound(vnd * 100n * 1_000_000n, rateToScaled(r.rate.toString()))) / 100, vnd, rate: r.rate.toString() };
}

/**
 * Tính lại giá vốn mọi đơn của một tháng: FF + ship từ đơn fulfill, chi phí chung phân bổ theo tỷ trọng
 * doanh thu ròng (đơn huỷ / hoàn toàn bộ không gánh). Trả về chi phí cố định đã dùng.
 */
export async function recomputeOrderCosts(tx: Tx, year: number, month: number) {
  const from = dayOfMonth(year, month - 1, 1);
  const to = dayOfMonth(year, month - 1, 31);
  const orders = await tx.order.findMany({ where: { orderedAt: { gte: from, lte: to } }, include: { fulfillments: true, refunds: true } });
  const fixed = await monthlyFixedCostUsd(tx, year, month);
  const bearing = orders.map((o) => (o.status === "CANCELLED" || o.status === "REFUNDED" ? 0 : Number(o.netUsd) - o.refunds.reduce((a, r) => a + Number(r.amountUsd), 0)));
  const overhead = allocateByRevenue(bearing, fixed.usd);
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const ok = o.fulfillments.filter((f) => f.status !== "FAILED");
    const data = {
      ffCostUsd: c2(ok.reduce((a, f) => a + Number(f.costUsd), 0)),
      shipCostUsd: c2(ok.reduce((a, f) => a + Number(f.shipUsd), 0)),
      overheadUsd: overhead[i],
    };
    await tx.orderCost.upsert({ where: { orderId: o.id }, create: { orderId: o.id, ...data }, update: data });
  }
  return { orders: orders.length, fixedCostUsd: fixed.usd };
}
