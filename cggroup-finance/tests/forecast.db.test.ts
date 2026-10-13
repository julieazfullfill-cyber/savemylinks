import { vi } from "vitest";

// Schema riêng của file này (xem tests/global-setup.ts) — phải chạy trước khi Prisma kết nối.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DB_URL_FORECAST;
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { buildForecast } from "@/lib/forecast";
import { loadForecastInput } from "@/lib/forecast-data";
import { postCashTxn } from "@/lib/ledger";
import { createBill } from "@/lib/payables";
import { seedCatalog } from "../prisma/seed-data";

const start = d("2026-12-07"); // thứ Hai

beforeAll(async () => {
  await seedCatalog(prisma);
  const bank = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "BANKVN" } })).id;
  const shop = await prisma.shop.create({ data: { code: "ET-FC", name: "Etsy dự báo", channel: "ETSY" } });
  const ff = await prisma.expenseCategory.findUniqueOrThrow({ where: { code: "FULFILL" } });
  await prisma.expenseCategory.update({ where: { code: "THUE_VP" }, data: { dueDay: 15, budgetVnd: 20_000_000n } });

  await prisma.$transaction(async (tx) => {
    await postCashTxn(tx, { date: d("2026-09-01"), accountId: bank, direction: "IN", opening: true, amount: 500_000_000n, description: "đầu kỳ", actorId: "t" });
    // 90 ngày qua: 3 lần thu Etsy tổng 300tr → trung bình 100tr/tháng; giá vốn 105tr → 35%
    for (const [day, amt] of [["2026-10-01", 100_000_000n], ["2026-11-01", 100_000_000n], ["2026-12-01", 100_000_000n]] as const) {
      await postCashTxn(tx, { date: d(day), accountId: bank, direction: "IN", shopIncome: true, shopId: shop.id, amount: amt, description: "payout", actorId: "t" });
    }
    await postCashTxn(tx, { date: d("2026-11-15"), accountId: bank, direction: "OUT", categoryId: ff.id, amount: 105_000_000n, description: "ff", actorId: "t" });
  });
  const sup = await prisma.supplier.findUniqueOrThrow({ where: { code: "GEARMENT" } });
  await prisma.$transaction((tx) => createBill(tx, { supplierId: sup.id, issueDate: d("2026-12-01"), dueDate: d("2026-12-10"), amount: 7_000_000n, currency: "VND", actorId: "t" }));
  await prisma.accountBalance.create({ data: { accountId: bank, date: addDays(start, -1), available: 0n, reserved: 40_000_000n, releaseOn: d("2026-12-23") } });
});
afterAll(() => prisma.$disconnect());

describe("loadForecastInput", () => {
  it("nạp số dư, doanh thu theo kênh, giá vốn lịch sử, tiền giam, hoá đơn, chi phí định kỳ", async () => {
    const { input, defaults } = await prisma.$transaction((tx) => loadForecastInput(tx, { startDate: start }));
    // 500 + 300 − 105 = 695tr (hoá đơn chưa trả không làm giảm tiền)
    expect(input.openingAvailableVnd).toBe(695_000_000n);
    expect(input.channels).toEqual([{ channel: "ETSY", monthlyVnd: 100_000_000n, payoutEveryDays: 7, anchor: d("2026-12-01") }]);
    // giá vốn = 105tr fulfill + 7tr hoá đơn Gearment (Nợ 501) = 112tr / 300tr
    expect(defaults).toMatchObject({ ffRate: 0.3733, ffRateFromHistory: true });
    expect(input.reserves).toEqual([{ releaseOn: d("2026-12-23"), amountVnd: 40_000_000n }]);
    expect(input.bills).toEqual([{ dueDate: d("2026-12-10"), outstandingVnd: 7_000_000n }]);
    expect(input.recurring).toContainEqual({ label: "Thuê văn phòng", dueDay: 15, amountVnd: 20_000_000n });

    const rows = buildForecast(input);
    expect(rows[0].billsOut).toBe(7_000_000n);
    expect(rows[2].reserveIn).toBe(40_000_000n);
    expect(rows[1].fixedOut).toBe(20_000_000n); // 15/12 nằm tuần 14–20/12
  });
});
