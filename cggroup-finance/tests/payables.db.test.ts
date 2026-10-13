// Công nợ NCC trên Postgres thật (schema tạm, xem global-setup.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { voidCashTxn } from "@/lib/ledger";
import { agingBucket, createBill, payBill } from "@/lib/payables";
import { seedCatalog } from "../prisma/seed-data";

let vnd = "";
let usd = "";
let merchize = "";

beforeAll(async () => {
  await seedCatalog(prisma);
  vnd = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "BANKVN" } })).id;
  usd = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "AWHK" } })).id;
  merchize = (await prisma.supplier.update({ where: { code: "MERCHIZE" }, data: { prepaid: false, creditDays: 30 } })).id;
  for (const [date, rate] of [["2026-11-01", "25000"], ["2026-11-20", "25500"]] as const) {
    await prisma.fxRate.upsert({
      where: { date_base_quote: { date: d(date), base: "USD", quote: "VND" } },
      create: { date: d(date), base: "USD", quote: "VND", rate },
      update: { rate },
    });
  }
});
afterAll(() => prisma.$disconnect());

const linesOf = (id: string) => prisma.journalLine.findMany({ where: { entryId: id } });

describe("hoá đơn NCC", () => {
  it("nhận hoá đơn: hạn = ngày HĐ + công nợ NCC; Nợ 501 / Có 201", async () => {
    const bill = await prisma.$transaction((tx) =>
      createBill(tx, { supplierId: merchize, billNo: "M-1", issueDate: d("2026-11-02"), amount: 10_000_000n, currency: "VND", actorId: "t" }),
    );
    expect(bill.dueDate).toEqual(d("2026-12-02"));
    expect((await linesOf(bill.journalId!)).map((l) => [l.accountCode, l.debitVnd, l.creditVnd]).sort()).toEqual([
      ["201", 0n, 10_000_000n],
      ["501", 10_000_000n, 0n],
    ]);
  });

  it("trả từng phần → PARTIAL, trả đủ → PAID; không cho trả vượt", async () => {
    const bill = await prisma.$transaction((tx) =>
      createBill(tx, { supplierId: merchize, issueDate: d("2026-11-03"), amount: 6_000_000n, currency: "VND", actorId: "t" }),
    );
    const p1 = await prisma.$transaction((tx) => payBill(tx, { billId: bill.id, accountId: vnd, date: d("2026-11-10"), amount: 2_000_000n, actorId: "t" }));
    expect(p1.bill).toMatchObject({ status: "PARTIAL", paidVnd: 2_000_000n });
    const pay = await linesOf(p1.txn.journalId!);
    expect(pay.find((l) => l.accountCode === "201")?.debitVnd).toBe(2_000_000n);

    await expect(
      prisma.$transaction((tx) => payBill(tx, { billId: bill.id, accountId: vnd, date: d("2026-11-11"), amount: 9_000_000n, actorId: "t" })),
    ).rejects.toThrow(/vượt số còn nợ/);

    const p2 = await prisma.$transaction((tx) => payBill(tx, { billId: bill.id, accountId: vnd, date: d("2026-11-12"), amount: 4_000_000n, actorId: "t" }));
    expect(p2.bill.status).toBe("PAID");

    // huỷ lần trả thứ 2 ở Sổ quỹ → hoá đơn quay về PARTIAL
    await prisma.$transaction((tx) => voidCashTxn(tx, { id: p2.txn.id, actorId: "t", reason: "nhầm" }));
    expect((await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("PARTIAL");
  });

  it("hoá đơn USD trả ở tỷ giá cao hơn: tất toán, chênh lệch vào 701", async () => {
    const bill = await prisma.$transaction((tx) =>
      createBill(tx, { supplierId: merchize, issueDate: d("2026-11-05"), amount: 100_000n, currency: "USD", actorId: "t" }), // 1.000 $ × 25.000
    );
    expect(bill.amountVnd).toBe(25_000_000n);
    const r = await prisma.$transaction((tx) =>
      payBill(tx, { billId: bill.id, accountId: usd, date: d("2026-11-21"), amount: 100_000n, settle: true, actorId: "t" }), // × 25.500
    );
    expect(r.txn.amountVnd).toBe(25_500_000n);
    expect(r.bill).toMatchObject({ status: "PAID", paidVnd: 25_000_000n });
    const fx = await prisma.journalEntry.findFirstOrThrow({ where: { source: "ADJUST", memo: { contains: "Tất toán" } }, include: { lines: true } });
    expect(fx.lines.find((l) => l.accountCode === "701")?.debitVnd).toBe(500_000n);
  });

  it("tuổi nợ", () => {
    expect(agingBucket(d("2026-11-10"), d("2026-11-10"))).toBe("NOT_DUE");
    expect(agingBucket(d("2026-11-10"), d("2026-11-11"))).toBe("D1_30");
    expect(agingBucket(d("2026-08-01"), d("2026-11-10"))).toBe("D90_PLUS");
  });
});
