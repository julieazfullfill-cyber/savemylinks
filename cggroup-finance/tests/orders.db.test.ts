import { vi } from "vitest";

// Schema riêng của file này (xem tests/global-setup.ts) — phải chạy trước khi Prisma kết nối.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DB_URL_ORDERS;
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { postCashTxn, voidCashTxn } from "@/lib/ledger";
import { normalizeOrders, parseCsv } from "@/lib/order-import";
import { addFulfillment, addRefund, importFulfillments, importOrders, monthlyFixedCostUsd, recomputeOrderCosts } from "@/lib/orders";
import { createPayout, parsePayoutLines, postPayout, recognizedVsReceived } from "@/lib/payouts";
import { addSupplierPrice } from "@/lib/shops";
import { seedCatalog } from "../prisma/seed-data";

let shopId = "";
let merchize = "";

beforeAll(async () => {
  await seedCatalog(prisma);
  await prisma.fxRate.create({ data: { date: d("2026-11-01"), base: "USD", quote: "VND", rate: "25000" } });
  const entity = await prisma.legalEntity.create({ data: { code: "LLC1", name: "CG LLC", kind: "LLC", country: "US" } });
  const awhk = await prisma.cashAccount.findUniqueOrThrow({ where: { code: "AWHK" } });
  shopId = (await prisma.shop.create({ data: { code: "ET-1", name: "Etsy 1", channel: "ETSY", entityId: entity.id, payoutAccountId: awhk.id } })).id;
  merchize = (await prisma.supplier.findUniqueOrThrow({ where: { code: "MERCHIZE" } })).id;
});
afterAll(() => prisma.$disconnect());

const CSV = [
  "Sale Date,Order ID,Ship Country,Order Value,Shipping,Card Processing Fees,Sales Tax,SKU,Quantity",
  "11/03/2026,E-1,US,40.00,0,2.00,3.00,ORN-1,2",
  "11/04/2026,E-2,US,60.00,0,3.00,0,TEE-1,1",
].join("\n");

describe("nạp đơn + giá vốn", () => {
  it("nạp đơn, nạp lại thì bỏ qua", async () => {
    const n = normalizeOrders("ETSY", parseCsv(CSV));
    const r1 = await prisma.$transaction((tx) => importOrders(tx, { shopId, filename: "etsy.csv", orders: n.orders, rowCount: 2, errorCount: 0, actorId: "t" }));
    expect(r1.created).toBe(2);
    const r2 = await prisma.$transaction((tx) => importOrders(tx, { shopId, filename: "etsy.csv", orders: n.orders, rowCount: 2, errorCount: 0, actorId: "t" }));
    expect(r2).toMatchObject({ created: 0, skipped: ["E-1", "E-2"] });
    const e1 = await prisma.order.findFirstOrThrow({ where: { externalId: "E-1" }, include: { items: true } });
    expect(Number(e1.netUsd)).toBe(35);
    expect(e1.items.map((i) => [i.sku, i.qty, Number(i.unitPriceUsd)])).toEqual([["ORN-1", 2, 20]]);
  });

  it("đơn fulfill lấy giá bảng giá × số lượng; CSV NCC ghép theo mã đơn", async () => {
    await prisma.$transaction((tx) => addSupplierPrice(tx, { supplierId: merchize, sku: "ORN-1", priceUsd: 8, effectiveFrom: d("2026-10-01"), actorId: "t" }));
    const e1 = await prisma.order.findFirstOrThrow({ where: { externalId: "E-1" } });
    const f = await prisma.$transaction((tx) => addFulfillment(tx, { orderId: e1.id, supplierId: merchize, sku: null, externalId: "MZ-1", submittedAt: d("2026-11-03"), costUsd: 18, shipUsd: 4, trackingNo: null, actorId: "t" }));
    expect(Number(f.listedCostUsd)).toBe(16);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: e1.id } })).status).toBe("PROCESSING");

    const r = await prisma.$transaction((tx) =>
      importFulfillments(tx, parseCsv("shopCode,orderId,supplierCode,externalId,costUsd,shipUsd\nET-1,E-2,MERCHIZE,MZ-2,25,5\nET-1,E-9,MERCHIZE,MZ-9,1,0\nET-1,E-1,MERCHIZE,MZ-1,1,0"), "t"),
    );
    expect(r.map((x) => x.status)).toEqual(["ok", "error", "skip"]);
  });

  it("chi phí cố định từ sổ cái (TK 60x) phân bổ theo doanh thu", async () => {
    const bank = await prisma.cashAccount.findUniqueOrThrow({ where: { code: "BANKVN" } });
    const rent = await prisma.expenseCategory.findUniqueOrThrow({ where: { code: "THUE_VP" } });
    await prisma.$transaction((tx) => postCashTxn(tx, { date: d("2026-11-05"), accountId: bank.id, direction: "OUT", categoryId: rent.id, amount: 2_500_000n, description: "Thuê VP", actorId: "t" })); // 100 $
    expect((await prisma.$transaction((tx) => monthlyFixedCostUsd(tx, 2026, 11))).usd).toBe(100);
    await prisma.$transaction((tx) => recomputeOrderCosts(tx, 2026, 11));
    const costs = await prisma.orderCost.findMany({ include: { order: true }, orderBy: { order: { externalId: "asc" } } });
    // net E-1 35, E-2 57 → 100$ chia 35/92 và 57/92
    expect(costs.map((c) => [c.order.externalId, Number(c.ffCostUsd), Number(c.shipCostUsd), Number(c.overheadUsd)])).toEqual([
      ["E-1", 18, 4, 38.04],
      ["E-2", 25, 5, 61.96],
    ]);
  });

  it("hoàn toàn bộ → REFUNDED; không hoàn vượt giá trị", async () => {
    const e2 = await prisma.order.findFirstOrThrow({ where: { externalId: "E-2" } });
    await expect(prisma.$transaction((tx) => addRefund(tx, { orderId: e2.id, refundedAt: d("2026-11-10"), amountUsd: 999, reason: null, actorId: "t" }))).rejects.toThrow(/vượt/);
    await prisma.$transaction((tx) => addRefund(tx, { orderId: e2.id, refundedAt: d("2026-11-10"), amountUsd: 57, reason: "hỏng", actorId: "t" }));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: e2.id } })).status).toBe("REFUNDED");
  });
});

describe("payout", () => {
  it("đối soát với đơn, ghi vào Sổ quỹ (Thu từ shop → 401), huỷ thì gỡ liên kết", async () => {
    const lines = parsePayoutLines(parseCsv("orderId,amountUsd,kind\nE-1,35,ORDER\nE-7,10,ORDER\n,-1,FEE"));
    const { payoutId, result } = await prisma.$transaction((tx) =>
      createPayout(tx, { shopId, periodFrom: d("2026-11-01"), periodTo: d("2026-11-07"), grossUsd: 46, feeUsd: 1, netUsd: 44, arrivedAt: d("2026-11-10"), lines, actorId: "t" }),
    );
    expect(result).toMatchObject({ matchedUsd: 35, unmatchedUsd: 9, diffUsd: 0, balanced: true, unknownOrderIds: ["E-7"] });
    const pl = await prisma.payoutLine.findMany({ where: { payoutId }, orderBy: { amountUsd: "desc" } });
    expect(pl[0].orderId).not.toBeNull();

    const txn = await prisma.$transaction((tx) => postPayout(tx, { payoutId, actorId: "t" }));
    expect(txn.amount).toBe(4_400n);
    const j = await prisma.journalLine.findMany({ where: { entryId: txn.journalId! } });
    expect(j.map((l) => l.accountCode).sort()).toEqual(["103", "401"]);
    await expect(prisma.$transaction((tx) => postPayout(tx, { payoutId, actorId: "t" }))).rejects.toThrow(/đã ghi/);

    const gap = await prisma.$transaction((tx) => recognizedVsReceived(tx, d("2026-11-01"), d("2026-11-30"), "25000"));
    expect(gap).toEqual({ recognizedUsd: 92, receivedUsd: 44 });

    await prisma.$transaction((tx) => voidCashTxn(tx, { id: txn.id, actorId: "t", reason: "nhầm" }));
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } })).cashTxnId).toBeNull();
  });
});
