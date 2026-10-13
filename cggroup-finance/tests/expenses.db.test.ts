import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { approveExpense, createExpense, monthlySpendByCategory, payExpense, rejectExpense } from "@/lib/expenses";
import { voidCashTxn } from "@/lib/ledger";
import { seedCatalog } from "../prisma/seed-data";

let bank = "";
let vps = "";

beforeAll(async () => {
  await seedCatalog(prisma);
  bank = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "BANKVN" } })).id;
  vps = (await prisma.expenseCategory.findUniqueOrThrow({ where: { code: "VPS_TOOL" } })).id;
});
afterAll(() => prisma.$disconnect());

const make = (amount: bigint, by = "nv1") =>
  prisma.$transaction((tx) =>
    createExpense(tx, { date: d("2026-11-05"), categoryId: vps, amount, currency: "VND", description: "Gia hạn VPS", requestedBy: by }),
  );

describe("đề nghị chi", () => {
  it("duyệt → Nợ 605 / Có 201; chi → Nợ 201 / Có 102; huỷ giao dịch chi → quay về APPROVED", async () => {
    const e = await make(3_000_000n);
    await expect(prisma.$transaction((tx) => approveExpense(tx, { id: e.id, actorId: "nv1", actorRole: "QUAN_LY" }))).rejects.toThrow(/Không tự duyệt/);

    const a = await prisma.$transaction((tx) => approveExpense(tx, { id: e.id, actorId: "gd", actorRole: "QUAN_LY" }));
    const j = await prisma.journalLine.findMany({ where: { entryId: a.journalId! } });
    expect(j.map((l) => [l.accountCode, l.debitVnd, l.creditVnd]).sort()).toEqual([
      ["201", 0n, 3_000_000n],
      ["605", 3_000_000n, 0n],
    ]);

    const paid = await prisma.$transaction((tx) => payExpense(tx, { id: e.id, accountId: bank, date: d("2026-11-06"), actorId: "kt" }));
    expect(paid.expense.status).toBe("PAID");
    expect(paid.txn.amountVnd).toBe(3_000_000n);
    const pj = await prisma.journalLine.findMany({ where: { entryId: paid.txn.journalId! } });
    expect(pj.find((l) => l.accountCode === "201")?.debitVnd).toBe(3_000_000n);

    await prisma.$transaction((tx) => voidCashTxn(tx, { id: paid.txn.id, actorId: "kt", reason: "chi nhầm TK" }));
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("APPROVED");
  });

  it("từ chối cần lý do; không chi được đề nghị chưa duyệt", async () => {
    const e = await make(1n);
    await expect(prisma.$transaction((tx) => payExpense(tx, { id: e.id, accountId: bank, date: d("2026-11-06"), actorId: "kt" }))).rejects.toThrow(/đã duyệt/);
    await expect(prisma.$transaction((tx) => rejectExpense(tx, { id: e.id, actorId: "gd", reason: " " }))).rejects.toThrow(/lý do/);
    const r = await prisma.$transaction((tx) => rejectExpense(tx, { id: e.id, actorId: "gd", reason: "Không cần" }));
    expect(r.status).toBe("REJECTED");
  });

  it("chi tiêu tháng theo hạng mục gồm đề nghị đã duyệt", async () => {
    const m = await prisma.$transaction((tx) => monthlySpendByCategory(tx, 2026, 11));
    expect(m.get(vps)).toBe(3_000_000n);
  });
});
