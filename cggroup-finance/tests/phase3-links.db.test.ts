import { vi } from "vitest";

// Schema riêng của file này (xem tests/global-setup.ts) — phải chạy trước khi Prisma kết nối.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DB_URL_PHASE3_LINKS;
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { buildForecast } from "@/lib/forecast";
import { loadForecastInput } from "@/lib/forecast-data";
import { postCashTxn } from "@/lib/ledger";
import { loadOrderAlerts } from "@/lib/order-alerts-data";
import { seedCatalog } from "../prisma/seed-data";

const start = d("2026-11-02"); // thứ Hai

beforeAll(async () => {
  await seedCatalog(prisma);
  await prisma.fxRate.create({ data: { date: d("2026-10-01"), base: "USD", quote: "VND", rate: "25000" } });
  const entity = await prisma.legalEntity.create({ data: { code: "LLC1", name: "CG LLC", kind: "LLC", country: "US" } });
  const awhk = await prisma.cashAccount.findUniqueOrThrow({ where: { code: "AWHK" } });
  const shop = await prisma.shop.create({ data: { code: "ET-1", name: "Etsy", channel: "ETSY", entityId: entity.id, payoutAccountId: awhk.id } });
  // đơn đã bán 03/11 chưa về: Etsy chu kỳ 7, trễ 3 → về 12/11 (tuần 2)
  await prisma.order.create({ data: { shopId: shop.id, externalId: "E-1", orderedAt: d("2026-11-03"), grossUsd: 100, netUsd: 100 } });
  await prisma.order.create({ data: { shopId: shop.id, externalId: "E-X", orderedAt: d("2026-11-03"), grossUsd: 50, netUsd: 50, status: "CANCELLED" } });
  await prisma.entityFiling.create({ data: { entityId: entity.id, kind: "RENEWAL", dueDate: d("2026-11-20"), amountVnd: 9_000_000n } });
  await prisma.entityFiling.create({ data: { entityId: entity.id, kind: "TAX_5472", dueDate: d("2026-11-25"), amountVnd: 1n, status: "DONE" } });
  // toàn bộ tiền thu đi qua một tài khoản → cảnh báo tập trung
  await prisma.$transaction((tx) =>
    postCashTxn(tx, { date: d("2026-10-30"), accountId: awhk.id, direction: "IN", shopIncome: true, shopId: shop.id, amount: 100_000n, description: "p", actorId: "t" }),
  );
});
afterAll(() => prisma.$disconnect());

describe("nối GĐ3 vào dự báo và màn 1", () => {
  it("dự báo: đơn chờ về theo lịch payout thật; nghĩa vụ pháp nhân còn mở là khoản chi", async () => {
    const { input, pendingOrders, filings } = await prisma.$transaction((tx) => loadForecastInput(tx, { startDate: start }));
    expect(pendingOrders).toBe(1);
    expect(filings).toBe(1);
    expect(input.pipeline).toEqual([{ expectedOn: d("2026-11-12"), amountVnd: 2_500_000n }]);
    const rows = buildForecast(input);
    expect(rows[1].pipelineIn).toBe(2_500_000n);
    expect(rows[2].manualOut).toBe(9_000_000n); // 20/11 nằm tuần 16–22/11
    // kênh Etsy có dữ liệu đơn → doanh thu trung bình neo sau ngày bắt đầu (không đếm trùng tuần 1–2)
    expect(input.channels[0].anchor).toEqual(d("2026-11-12"));
  });

  it("màn 1 nhận cảnh báo GĐ3 (tập trung dòng tiền, đơn chưa ghép fulfill)", async () => {
    const a = await prisma.$transaction((tx) => loadOrderAlerts(tx, d("2026-11-10")));
    expect(a.map((x) => x.href)).toEqual(expect.arrayContaining(["/tap-trung", "/don-hang?loc=chua-ghep"]));
    expect(a.find((x) => x.href === "/tap-trung")?.severity).toBe("crit");
  });
});
