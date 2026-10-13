import { vi } from "vitest";

// Schema riêng của file này (xem tests/global-setup.ts) — phải chạy trước khi Prisma kết nối.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DB_URL_KPI;
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { saveKpiMonth, shopIncomeUsd } from "@/lib/kpi-service";
import { postCashTxn } from "@/lib/ledger";
import { seedCatalog } from "../prisma/seed-data";
import { seedPhase2 } from "../prisma/seed-phase2";

let a = "";
let b = "";
let shopA = "";

beforeAll(async () => {
  await seedCatalog(prisma);
  await seedPhase2(prisma);
  await prisma.fxRate.create({ data: { date: d("2026-10-01"), base: "USD", quote: "VND", rate: "25000" } });
  a = (await prisma.employee.create({ data: { code: "NV15", fullName: "Thảo", joinedAt: d("2026-01-01") } })).id;
  b = (await prisma.employee.create({ data: { code: "NV03", fullName: "Trung", joinedAt: d("2026-01-01") } })).id;
  shopA = (await prisma.shop.create({ data: { code: "AMZ-1", name: "Amazon 1", channel: "AMAZON" } })).id;
  const shopB = (await prisma.shop.create({ data: { code: "ET-1", name: "Etsy 1", channel: "ETSY" } })).id;
  const usd = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "AWHK" } })).id;
  const vnd = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "BANKVN" } })).id;
  await prisma.$transaction(async (tx) => {
    await postCashTxn(tx, { date: d("2026-10-10"), accountId: usd, direction: "IN", shopIncome: true, shopId: shopA, amount: 800_000n, description: "p", actorId: "t" }); // 8.000 $
    await postCashTxn(tx, { date: d("2026-10-12"), accountId: vnd, direction: "IN", shopIncome: true, shopId: shopB, amount: 50_000_000n, description: "p", actorId: "t" }); // 2.000 $
  });
});
afterAll(() => prisma.$disconnect());

describe("KPI tháng 10", () => {
  it("tiền thực về từ Sổ quỹ theo shop, quy USD", async () => {
    const { byShop } = await prisma.$transaction((tx) => shopIncomeUsd(tx, 2026, 10));
    expect(byShop.get(shopA)).toBe(8000);
    expect([...byShop.values()].reduce((x, y) => x + y, 0)).toBe(10_000);
  });

  it("phân bổ chi phí chung theo tỷ trọng, bậc thưởng theo % đạt, trên phần vượt", async () => {
    const { results } = await prisma.$transaction((tx) =>
      saveKpiMonth(tx, {
        year: 2026,
        month: 10,
        overheadTotalUsd: 1000,
        rows: [
          { employeeId: a, targetUsd: 4000, shopIds: [shopA], cashReceivedUsd: 8000, ffCostUsd: 2800 }, // overhead 800 → profit 4.400 → 110%
          { employeeId: b, targetUsd: 2000, shopIds: [], cashReceivedUsd: 2000, ffCostUsd: 700 }, // overhead 200 → profit 1.100 → 55%
        ],
        actorId: "gd",
      }),
    );
    const ra = results.find((r) => r.employeeId === a)!;
    expect(Number(ra.overheadUsd)).toBe(800);
    expect(Number(ra.profitUsd)).toBe(4400);
    expect(Number(ra.achievedPct)).toBe(1.1);
    expect(ra.bonusVnd).toBe(200_000n); // vượt 400 $ × 25.000 × 2%
    const rb = results.find((r) => r.employeeId === b)!;
    expect(rb.bonusVnd).toBe(0n);
    expect((await prisma.kpiTarget.findFirstOrThrow({ where: { employeeId: a } })).shopIds).toEqual([shopA]);
  });
});
