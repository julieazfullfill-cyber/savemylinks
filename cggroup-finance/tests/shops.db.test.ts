import { vi } from "vitest";

// Schema riêng của file này (xem tests/global-setup.ts) — phải chạy trước khi Prisma kết nối.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DB_URL_SHOPS;
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { postCashTxn } from "@/lib/ledger";
import { addSupplierPrice, changeShopStatus, incomeByAccount, listedPrice, saveShop, troubleStats } from "@/lib/shops";
import { seedCatalog } from "../prisma/seed-data";

let entity = "";
let awhk = "";
let bank = "";
let supplier = "";

beforeAll(async () => {
  await seedCatalog(prisma);
  entity = (await prisma.legalEntity.create({ data: { code: "LLC1", name: "CG LLC", kind: "LLC", country: "US" } })).id;
  awhk = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "AWHK" } })).id;
  bank = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "BANKVN" } })).id;
  supplier = (await prisma.supplier.findUniqueOrThrow({ where: { code: "MERCHIZE" } })).id;
});
afterAll(() => prisma.$disconnect());

const base = { name: "Shop", channel: "ETSY", ownerId: null, openedAt: null, actorId: "t" };

describe("shop", () => {
  it("bắt buộc pháp nhân và tài khoản nhận tiền; trạng thái sai bị DB chặn", async () => {
    await expect(prisma.$transaction((tx) => saveShop(tx, null, { ...base, code: "x", entityId: null, payoutAccountId: awhk }))).rejects.toThrow(/pháp nhân/);
    await expect(prisma.$transaction((tx) => saveShop(tx, null, { ...base, code: "x", entityId: entity, payoutAccountId: null }))).rejects.toThrow(/nhận tiền/);
    const s = await prisma.$transaction((tx) => saveShop(tx, null, { ...base, code: "et-a", entityId: entity, payoutAccountId: awhk }));
    expect(s.code).toBe("ET-A");
    await expect(prisma.shop.update({ where: { id: s.id }, data: { status: "PAUSED" } })).rejects.toThrow(/shop_status/);
  });

  it("đổi trạng thái ghi lịch sử; thống kê sự cố theo kênh", async () => {
    const s = await prisma.shop.findUniqueOrThrow({ where: { code: "ET-A" } });
    await prisma.$transaction((tx) => changeShopStatus(tx, { shopId: s.id, toStatus: "SUSPENDED", at: d("2026-11-01"), note: "case 123", actorId: "t" }));
    await prisma.$transaction((tx) => changeShopStatus(tx, { shopId: s.id, toStatus: "ACTIVE", at: d("2026-11-05"), note: null, actorId: "t" }));
    await expect(prisma.$transaction((tx) => changeShopStatus(tx, { shopId: s.id, toStatus: "ACTIVE", at: d("2026-11-06"), note: null, actorId: "t" }))).rejects.toThrow(/đã ở trạng thái/);
    const ev = await prisma.shopHealthEvent.findMany({ where: { shopId: s.id }, orderBy: { at: "asc" } });
    expect(ev.map((e) => [e.fromStatus, e.toStatus])).toEqual([["ACTIVE", "SUSPENDED"], ["SUSPENDED", "ACTIVE"]]);
    expect(troubleStats([{ id: s.id, key: "Etsy" }, { id: "z", key: "Amazon" }], ev)).toEqual([
      { key: "Etsy", shops: 1, incidents: 1, perShop: 1 },
      { key: "Amazon", shops: 1, incidents: 0, perShop: 0 },
    ]);
  });

  it("tỷ trọng tiền thu theo tài khoản nhận", async () => {
    const s = await prisma.shop.findUniqueOrThrow({ where: { code: "ET-A" } });
    await prisma.$transaction(async (tx) => {
      await tx.fxRate.create({ data: { date: d("2026-11-01"), base: "USD", quote: "VND", rate: "25000" } });
      await postCashTxn(tx, { date: d("2026-11-10"), accountId: awhk, direction: "IN", shopIncome: true, shopId: s.id, amount: 300_000n, description: "p", actorId: "t" }); // 75tr
      await postCashTxn(tx, { date: d("2026-11-11"), accountId: bank, direction: "IN", shopIncome: true, shopId: s.id, amount: 25_000_000n, description: "p", actorId: "t" });
    });
    const r = await prisma.$transaction((tx) => incomeByAccount(tx, d("2026-11-01"), d("2026-11-30")));
    expect(r.map((x) => [x.code, x.vnd, x.share])).toEqual([["AWHK", 75_000_000n, 0.75], ["BANKVN", 25_000_000n, 0.25]]);
  });
});

describe("bảng giá NCC", () => {
  it("giá mới đóng giá cũ; tra giá theo ngày; không chèn lùi", async () => {
    await prisma.$transaction((tx) => addSupplierPrice(tx, { supplierId: supplier, sku: "orn-1", priceUsd: 8, effectiveFrom: d("2026-07-01"), actorId: "t" }));
    await prisma.$transaction((tx) => addSupplierPrice(tx, { supplierId: supplier, sku: "ORN-1", priceUsd: 9.5, effectiveFrom: d("2026-08-01"), actorId: "t" }));
    const all = await prisma.supplierPrice.findMany({ where: { sku: "ORN-1" }, orderBy: { effectiveFrom: "asc" } });
    expect(all[0].effectiveTo).toEqual(d("2026-07-31"));
    expect(await prisma.$transaction((tx) => listedPrice(tx, supplier, "orn-1", d("2026-07-15")))).toBe(8);
    expect(await prisma.$transaction((tx) => listedPrice(tx, supplier, "ORN-1", d("2026-08-15")))).toBe(9.5);
    expect(await prisma.$transaction((tx) => listedPrice(tx, supplier, "ORN-1", d("2026-06-01")))).toBeNull();
    await expect(prisma.$transaction((tx) => addSupplierPrice(tx, { supplierId: supplier, sku: "ORN-1", priceUsd: 1, effectiveFrom: d("2026-07-15"), actorId: "t" }))).rejects.toThrow(/phải sau/);
  });
});
