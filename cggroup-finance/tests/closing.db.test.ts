import { vi } from "vitest";

// Schema riêng của file này (xem tests/global-setup.ts) — phải chạy trước khi Prisma kết nối.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DB_URL_CLOSING;
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewAllocation, runAllocation, saveRule, undoAllocation } from "@/lib/allocation-service";
import { closePeriod, closingStatus, reopenPeriod, runChecks } from "@/lib/closing-service";
import { parseBizDate as d, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { balanceSheet, profitAndLoss } from "@/lib/gl";
import { loadGlLines, monthRange } from "@/lib/gl-data";
import { postCashTxn, voidCashTxn } from "@/lib/ledger";
import { createAr, createTax, payTax, receiveAr } from "@/lib/receivables";
import { seedCatalog } from "../prisma/seed-data";

const A = "tester";
let bank = "";
let shopA = "";
let shopB = "";
let ruleId = "";
let officeTxn = "";

beforeAll(async () => {
  await seedCatalog(prisma);
  bank = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "BANKVN" } })).id;
  const entity = await prisma.legalEntity.create({ data: { code: "HKD", name: "HKD", kind: "HO_KINH_DOANH", country: "VN" } });
  shopA = (await prisma.shop.create({ data: { code: "ET-A", name: "A", channel: "ETSY", entityId: entity.id, payoutAccountId: bank } })).id;
  shopB = (await prisma.shop.create({ data: { code: "AMZ-B", name: "B", channel: "AMAZON", entityId: entity.id, payoutAccountId: bank } })).id;
  const office = (await prisma.expenseCategory.findUniqueOrThrow({ where: { code: "THUE_VP" } })).id;
  await prisma.$transaction(async (tx) => {
    await postCashTxn(tx, { date: d("2026-08-31"), accountId: bank, direction: "IN", opening: true, amount: 100_000_000n, description: "đầu kỳ", actorId: A });
    await postCashTxn(tx, { date: d("2026-09-05"), accountId: bank, direction: "IN", shopIncome: true, shopId: shopA, amount: 30_000_000n, description: "A", actorId: A });
    await postCashTxn(tx, { date: d("2026-09-06"), accountId: bank, direction: "IN", shopIncome: true, shopId: shopB, amount: 10_000_000n, description: "B", actorId: A });
    officeTxn = (await postCashTxn(tx, { date: d("2026-09-07"), accountId: bank, direction: "OUT", categoryId: office, amount: 8_000_001n, description: "thuê VP", actorId: A })).id;
  });
});
afterAll(() => prisma.$disconnect());

const sepPnl = async () => profitAndLoss(await loadGlLines(prisma, { ...monthRange(2026, 9), excludeClosing: true }));

describe("phân bổ chi phí chung", () => {
  it("chia TK 603 theo doanh thu 3:1, khớp từng đồng, P&L công ty không đổi", async () => {
    ruleId = (await prisma.$transaction((tx) => saveRule(tx, { name: "Văn phòng", sourceAccounts: ["603"], basis: "REVENUE", active: true, actorId: A }))).id;
    const pv = await prisma.$transaction((tx) => previewAllocation(tx, { ruleId, year: 2026, month: 9 }));
    expect(pv.poolVnd).toBe(8_000_001n);
    expect(pv.byShop.map((s) => s.amountVnd)).toEqual([6_000_001n, 2_000_000n]);
    const before = (await sepPnl()).netProfitVnd;
    await prisma.$transaction((tx) => runAllocation(tx, { ruleId, year: 2026, month: 9, actorId: A }));
    expect((await sepPnl()).netProfitVnd).toBe(before);
    const byShop = await loadGlLines(prisma, { ...monthRange(2026, 9), by: "shop", types: ["EXPENSE"] });
    expect(byShop.find((l) => l.dim === shopA)!.debitVnd).toBe(6_000_001n);
    await expect(prisma.$transaction((tx) => runAllocation(tx, { ruleId, year: 2026, month: 9, actorId: A }))).rejects.toThrow(/đã chạy/);
  });

  it("huỷ lần chạy rồi chạy lại được", async () => {
    const run = await prisma.allocationRun.findFirstOrThrow({ where: { ruleId } });
    await prisma.$transaction((tx) => undoAllocation(tx, { runId: run.id, actorId: A }));
    expect(await prisma.allocationRun.count()).toBe(0);
    await prisma.$transaction((tx) => runAllocation(tx, { ruleId, year: 2026, month: 9, actorId: A }));
  });
});

describe("đóng sổ", () => {
  it("chưa chốt số dư → cảnh báo + chặn đóng sổ", async () => {
    const { results } = await prisma.$transaction((tx) => runChecks(tx, { year: 2026, month: 9, actorId: A }));
    expect(results.map((r) => r.code)).toEqual(["CASH_NO_STATEMENT"]);
    const st = await prisma.$transaction((tx) => closingStatus(tx, 2026, 9));
    expect(st.canClose).toBe(false);
    await expect(prisma.$transaction((tx) => closePeriod(tx, { year: 2026, month: 9, actorId: A }))).rejects.toThrow(/số dư chốt/);
  });

  it("số dư chốt lệch sổ quỹ → ERROR", async () => {
    await prisma.accountBalance.create({ data: { accountId: bank, date: d("2026-09-30"), available: 131_000_000n } });
    const { results } = await prisma.$transaction((tx) => runChecks(tx, { year: 2026, month: 9, actorId: A }));
    expect(results[0]).toMatchObject({ code: "CASH_MISMATCH", level: "ERROR" });
    await prisma.accountBalance.update({ where: { accountId_date: { accountId: bank, date: d("2026-09-30") } }, data: { available: 131_999_999n } });
  });

  it("đóng sổ: kết chuyển về 302, P&L tháng vẫn đọc được, bảng cân đối cân", async () => {
    const { closing } = await prisma.$transaction((tx) => closePeriod(tx, { year: 2026, month: 9, actorId: A }));
    expect(closing.status).toBe("CLOSED");
    expect(closing.profitVnd).toBe(31_999_999n);
    expect((await sepPnl()).netProfitVnd).toBe(31_999_999n);
    const all = await loadGlLines(prisma, { to: d("2026-09-30") });
    expect(profitAndLoss(all).netProfitVnd).toBe(0n); // TK kết quả về 0
    expect(all.find((l) => l.accountCode === "302")!.creditVnd).toBe(31_999_999n);
    expect(balanceSheet(all).balanced).toBe(true);
    expect(await prisma.reportSnapshot.count({ where: { year: 2026, month: 9 } })).toBe(2);
  });

  it("kỳ đã đóng: không ghi được bút toán (ứng dụng + trigger DB)", async () => {
    await expect(
      prisma.$transaction((tx) => postCashTxn(tx, { date: d("2026-09-20"), accountId: bank, direction: "OUT", amount: 1n, description: "x", actorId: A })),
    ).rejects.toThrow(/đã đóng sổ/);
    await expect(
      prisma.journalEntry.create({ data: { date: d("2026-09-20"), memo: "lách", source: "ADJUST", createdBy: A } }),
    ).rejects.toThrow(/đã đóng sổ/);
  });

  it("huỷ giao dịch thuộc kỳ đã đóng → bút toán đảo ghi vào hôm nay", async () => {
    await prisma.$transaction((tx) => voidCashTxn(tx, { id: officeTxn, actorId: A, reason: "nhầm" }));
    const rev = await prisma.journalEntry.findFirstOrThrow({ where: { memo: { startsWith: "Huỷ: thuê VP" } } });
    expect(rev.date).toEqual(todayVn());
    expect((await sepPnl()).netProfitVnd).toBe(31_999_999n); // tháng 9 không đổi
  });

  it("mở lại kỳ: đảo kết chuyển, ghi được lại", async () => {
    await prisma.$transaction((tx) => reopenPeriod(tx, { year: 2026, month: 9, reason: "sửa số", actorId: A }));
    const all = await loadGlLines(prisma, { to: d("2026-09-30") });
    expect(profitAndLoss(all).netProfitVnd).toBe(31_999_999n);
    await prisma.$transaction((tx) => postCashTxn(tx, { date: d("2026-09-20"), accountId: bank, direction: "OUT", amount: 1n, description: "ok", actorId: A }));
  });
});

describe("phải thu và thuế", () => {
  it("thu nhiều lần; huỷ lần thu thì số đã thu tính lại", async () => {
    const inv = await prisma.$transaction((tx) =>
      createAr(tx, { counterparty: "Thuê TK", issueDate: d("2026-10-01"), dueDate: d("2026-10-10"), amountVnd: 10_000_000n, accountCode: "409", actorId: A }),
    );
    const r = await prisma.$transaction((tx) => receiveAr(tx, { invoiceId: inv.id, accountId: bank, date: d("2026-10-05"), amount: 4_000_000n, actorId: A }));
    expect(r).toMatchObject({ paidVnd: 4_000_000n, status: "PARTIAL" });
    await expect(
      prisma.$transaction((tx) => receiveAr(tx, { invoiceId: inv.id, accountId: bank, date: d("2026-10-05"), amount: 7_000_000n, actorId: A })),
    ).rejects.toThrow(/vượt/);
    const rec = await prisma.arReceipt.findFirstOrThrow({ where: { invoiceId: inv.id } });
    await prisma.$transaction((tx) => voidCashTxn(tx, { id: rec.cashTxnId, actorId: A, reason: "x" }));
    expect(await prisma.arInvoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ paidVnd: 0n, status: "OPEN" });
  });

  it("nộp TNCN ghi Nợ 204; huỷ thì mở lại", async () => {
    const t = await prisma.$transaction((tx) => createTax(tx, { kind: "TNCN", periodLabel: "09/2026", dueDate: d("2026-10-20"), amountVnd: 2_000_000n, actorId: A }));
    const paid = await prisma.$transaction((tx) => payTax(tx, { id: t.id, accountId: bank, date: d("2026-10-12"), amount: 2_000_000n, actorId: A }));
    expect(paid.status).toBe("PAID");
    const j = await prisma.cashTxn.findUniqueOrThrow({ where: { id: paid.cashTxnId! }, include: { journal: { include: { lines: true } } } });
    expect(j.journal!.lines.find((l) => l.debitVnd > 0n)!.accountCode).toBe("204");
    await prisma.$transaction((tx) => voidCashTxn(tx, { id: paid.cashTxnId!, actorId: A, reason: "x" }));
    expect((await prisma.taxObligation.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("OPEN");
  });
});
