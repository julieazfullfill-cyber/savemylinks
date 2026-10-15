import { vi } from "vitest";

// Schema riêng của file này (xem tests/global-setup.ts) — phải chạy trước khi Prisma kết nối.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DB_URL_REPORT_STAGING;
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import type { ParsedReport } from "@/lib/monthly-report";
import { amountIn, commitSource, matchShop, reconcile, saveRows, stageReport } from "@/lib/report-staging";
import { seedCatalog } from "../prisma/seed-data";

const A = "tester";
let shopId = "";

const parsed: ParsedReport = {
  fxRate: 26000,
  warnings: [],
  totals: { THU: 300, THU_ETSY: 200, THU_AMZ: 100, CHI: 50, LOI_NHUAN: 250 },
  lines: [
    { section: "ETSY", label: "Bank Việt · Lê Thị Tâm", ref: "TK 1", date: d("2026-08-31"), direction: "IN", amount: 5_200_000n, currency: "VND", note: null, hint: { account: "BANKVN", shopName: "Lê Thị Tâm" } },
    { section: "AMZ", label: "Amz AU1", ref: null, date: d("2026-08-31"), direction: "IN", amount: 10_000n, currency: "USD", note: null, hint: { account: "AWHK", incomeGl: "402" } },
    { section: "CHUNG", label: "Chat GPT", ref: null, date: d("2026-08-12"), direction: "OUT", amount: 1_300_000n, currency: "VND", note: null, hint: { category: "VPS_TOOL" } },
    { section: "OPEX", label: "Chi phí bảo hiểm", ref: null, date: d("2026-08-31"), direction: "OUT", amount: 999n, currency: "VND", note: null, hint: { category: "BHXH", skip: "Tạm bỏ qua BHXH" } },
  ],
};

beforeAll(async () => {
  await seedCatalog(prisma);
  const bank = await prisma.cashAccount.findUniqueOrThrow({ where: { code: "BANKVN" } });
  shopId = (await prisma.shop.create({ data: { code: "LTT", name: "Lê Thị Tâm (LTT)", channel: "ETSY", payoutAccountId: bank.id } })).id;
  await prisma.$transaction((tx) => stageReport(tx, { team: 1, year: 2026, month: 8, file: "test.xlsx", parsed, actorId: A }));
});
afterAll(() => prisma.$disconnect());

describe("thu chi lịch sử từ file báo cáo tháng", () => {
  it("ghép shop theo tên / mã trong ngoặc", () => {
    const shops = [{ id: "1", code: "NTT", name: "Nguyễn Thị Thu (NTT)" }, { id: "2", code: "HNP", name: "HNPcommerce - HippoLord" }];
    expect(matchShop("Nguyễn Tiến Thành(NTT)", shops)).toBe("1");
    expect(matchShop("HNP", shops)).toBe("2");
    expect(matchShop("Vũ Minh Đức", shops)).toBeNull();
  });

  it("quy đổi về loại tiền của tài khoản", () => {
    expect(amountIn("VND", 10_000n, "USD", "26000")).toBe(2_600_000n); // 100,00 USD
    expect(amountIn("USD", 2_600_000n, "VND", "26000")).toBe(10_000n);
  });

  it("vào vùng chờ: gợi ý shop, tài khoản, hạng mục; bảo hiểm bỏ qua; đối chiếu khớp", async () => {
    const rows = await prisma.stagedTxn.findMany({ where: { source: "T1-2026-08" }, orderBy: { line: "asc" } });
    expect(rows[0].shopId).toBe(shopId);
    expect(rows[1]).toMatchObject({ shopId: null, incomeGl: "402" });
    expect(rows[3].status).toBe("SKIP");
    const r = reconcile(parsed.totals, rows);
    expect(r.find((x) => x.key === "THU")!.diff).toBeCloseTo(0, 2);
    expect(r.find((x) => x.key === "CHI")!.diff).toBeCloseTo(0, 2); // 1.300.000 / 26000 = 50, bảo hiểm bỏ qua không tính
  });

  it("còn dòng thiếu tài khoản thì không chốt dòng nào", async () => {
    await expect(prisma.$transaction((tx) => commitSource(tx, { source: "T1-2026-08", actorId: A }))).rejects.toThrow(/Chat GPT \(tài khoản\)/);
    expect(await prisma.cashTxn.count()).toBe(0);
  });

  it("chốt: thành giao dịch Sổ quỹ (thu shop, thu Amazon Có 402, chi hạng mục), khoá dòng", async () => {
    const bank = await prisma.cashAccount.findUniqueOrThrow({ where: { code: "BANKVN" } });
    const chat = await prisma.stagedTxn.findFirstOrThrow({ where: { label: "Chat GPT" } });
    await prisma.$transaction((tx) => saveRows(tx, [{ id: chat.id, accountId: bank.id, categoryId: chat.categoryId }], A));
    const n = await prisma.$transaction((tx) => commitSource(tx, { source: "T1-2026-08", actorId: A }));
    expect(n).toBe(3);
    const amz = await prisma.cashTxn.findFirstOrThrow({ where: { description: { startsWith: "Amz AU1" } }, include: { journal: { include: { lines: true } } } });
    expect(amz.amount).toBe(10_000n); // AWHK là USD
    expect(amz.journal!.lines.find((l) => l.creditVnd > 0n)!.accountCode).toBe("402");
    const shopIn = await prisma.cashTxn.findFirstOrThrow({ where: { shopId } });
    expect(shopIn.amountVnd).toBe(5_200_000n);
    expect(await prisma.fxRate.count({ where: { date: d("2026-08-31") } })).toBe(1);
    const locked = await prisma.stagedTxn.findFirstOrThrow({ where: { label: "Chat GPT" } });
    expect(locked.status).toBe("LOCKED");
    await expect(prisma.stagedTxn.update({ where: { id: locked.id }, data: { note: "x" } })).rejects.toThrow(/đã chốt/);
  });
});
