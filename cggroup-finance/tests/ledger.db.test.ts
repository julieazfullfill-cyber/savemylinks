// Test tích hợp với Postgres thật (DB trong .env.test). Chạy: npm run test
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { parseBizDate } from "@/lib/dates";
import { postCashTxn, voidCashTxn } from "@/lib/ledger";
import { seedCatalog } from "../prisma/seed-data";

let usdAccountId = "";
let vndAccountId = "";
let fulfillCatId = "";

beforeAll(async () => {
  await seedCatalog(prisma);
  usdAccountId = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "AWHK" } })).id;
  vndAccountId = (await prisma.cashAccount.findUniqueOrThrow({ where: { code: "BANKVN" } })).id;
  fulfillCatId = (await prisma.expenseCategory.findUniqueOrThrow({ where: { code: "FULFILL" } })).id;
  await prisma.fxRate.upsert({
    where: { date_base_quote: { date: parseBizDate("2026-11-01"), base: "USD", quote: "VND" } },
    create: { date: parseBizDate("2026-11-01"), base: "USD", quote: "VND", rate: "25400" },
    update: { rate: "25400" },
  });
});

afterAll(() => prisma.$disconnect());

const linesOf = (journalId: string) => prisma.journalLine.findMany({ where: { entryId: journalId }, orderBy: { debitVnd: "desc" } });

describe("postCashTxn", () => {
  it("chi USD: tra tỷ giá gần nhất, Nợ 501 / Có 103, lưu cứng amountVnd", async () => {
    const txn = await prisma.$transaction((tx) =>
      postCashTxn(tx, {
        date: parseBizDate("2026-11-03"),
        accountId: usdAccountId,
        direction: "OUT",
        amount: 12_550n, // 125,50 $
        categoryId: fulfillCatId,
        description: "Nạp Merchize",
        actorId: "test",
      }),
    );
    expect(txn.amountVnd).toBe(3_187_700n);
    expect(txn.fxRate.toString()).toBe("25400");
    const lines = await linesOf(txn.journalId!);
    expect(lines.map((l) => [l.accountCode, l.debitVnd, l.creditVnd])).toEqual([
      ["501", 3_187_700n, 0n],
      ["103", 0n, 3_187_700n],
    ]);
    const log = await prisma.auditLog.findFirst({ where: { recordId: txn.id } });
    expect(log?.action).toBe("CREATE");
  });

  it("thu VND không hạng mục → Có 409", async () => {
    const txn = await prisma.$transaction((tx) =>
      postCashTxn(tx, {
        date: parseBizDate("2026-11-03"), accountId: vndAccountId, direction: "IN",
        amount: 5_000_000n, description: "Thu khác", actorId: "test",
      }),
    );
    const lines = await linesOf(txn.journalId!);
    expect(lines.map((l) => l.accountCode)).toEqual(["102", "409"]);
  });

  it("thiếu tỷ giá trước ngày giao dịch → lỗi rõ ràng", async () => {
    await expect(
      prisma.$transaction((tx) =>
        postCashTxn(tx, {
          date: parseBizDate("2020-01-01"), accountId: usdAccountId, direction: "IN",
          amount: 100n, description: "x", actorId: "test",
        }),
      ),
    ).rejects.toThrow(/Chưa có tỷ giá/);
  });
});

describe("thu từ shop", () => {
  it("doanh thu ghi theo kênh của shop: Amazon → 402, Walmart → 405", async () => {
    const amz = await prisma.shop.create({ data: { code: "AMZ-AU1", name: "Amazon AU1", channel: "AMAZON" } });
    const wm = await prisma.shop.create({ data: { code: "WM-01", name: "Walmart 01", channel: "WALMART" } });
    const post = (shopId: string) =>
      prisma.$transaction((tx) =>
        postCashTxn(tx, {
          date: parseBizDate("2026-11-05"), accountId: usdAccountId, direction: "IN", shopIncome: true, shopId,
          amount: 100_000n, description: "Payout", actorId: "test",
        }),
      );
    for (const [shop, gl] of [[amz.id, "402"], [wm.id, "405"]] as const) {
      const txn = await post(shop);
      const lines = await linesOf(txn.journalId!);
      expect(lines.map((l) => [l.accountCode, l.shopId])).toEqual([
        ["103", shop],
        [gl, shop],
      ]);
    }
  });

  it("thiếu shop / shop đã đóng / kênh lạ → lỗi", async () => {
    const base = {
      date: parseBizDate("2026-11-05"), accountId: usdAccountId, direction: "IN" as const, shopIncome: true,
      amount: 1n, description: "x", actorId: "test",
    };
    await expect(prisma.$transaction((tx) => postCashTxn(tx, base))).rejects.toThrow(/phải chọn shop/);
    const closed = await prisma.shop.create({ data: { code: "ET-OLD", name: "Etsy cũ", channel: "ETSY", status: "CLOSED" } });
    await expect(prisma.$transaction((tx) => postCashTxn(tx, { ...base, shopId: closed.id }))).rejects.toThrow(/đã đóng/);
    await expect(prisma.shop.create({ data: { code: "EBAY", name: "eBay", channel: "EBAY" } })).rejects.toThrow(/shop_channel/);
  });
});

describe("số dư đầu kỳ", () => {
  it("Nợ TK tiền / Có 301, nguồn OPENING; không cho gắn hạng mục hay ghi chi", async () => {
    const txn = await prisma.$transaction((tx) =>
      postCashTxn(tx, {
        date: parseBizDate("2026-10-31"), accountId: vndAccountId, direction: "IN", opening: true,
        amount: 150_000_000n, description: "Số dư đầu kỳ 31/10", actorId: "test",
      }),
    );
    const j = await prisma.journalEntry.findUniqueOrThrow({ where: { id: txn.journalId! }, include: { lines: true } });
    expect(j.source).toBe("OPENING");
    expect(j.lines.map((l) => l.accountCode).sort()).toEqual(["102", "301"]);
    await expect(
      prisma.$transaction((tx) =>
        postCashTxn(tx, {
          date: parseBizDate("2026-10-31"), accountId: vndAccountId, direction: "OUT", opening: true,
          amount: 1n, description: "x", actorId: "test",
        }),
      ),
    ).rejects.toThrow(/Số dư đầu kỳ là khoản thu/);
  });
});

describe("voidCashTxn", () => {
  it("không xoá: đánh dấu voidedAt + bút toán ngược, sổ cái về 0", async () => {
    const txn = await prisma.$transaction((tx) =>
      postCashTxn(tx, {
        date: parseBizDate("2026-11-04"), accountId: vndAccountId, direction: "OUT",
        amount: 777_000n, categoryId: fulfillCatId, description: "Sai số", actorId: "test",
      }),
    );
    const voided = await prisma.$transaction((tx) => voidCashTxn(tx, { id: txn.id, actorId: "test", reason: "nhập nhầm" }));
    expect(voided.voidedAt).not.toBeNull();

    const rev = await prisma.journalEntry.findFirstOrThrow({ where: { reversalOf: txn.journalId! }, include: { lines: true } });
    const net = await prisma.journalLine.groupBy({
      by: ["accountCode"],
      where: { entryId: { in: [txn.journalId!, rev.id] } },
      _sum: { debitVnd: true, creditVnd: true },
    });
    for (const n of net) expect(n._sum.debitVnd).toBe(n._sum.creditVnd);

    await expect(prisma.$transaction((tx) => voidCashTxn(tx, { id: txn.id, actorId: "test", reason: "lần 2" }))).rejects.toThrow(
      /đã huỷ/,
    );
  });
});

describe("chốt chặn ở DB", () => {
  it("trigger từ chối bút toán lệch lúc commit", async () => {
    await expect(
      prisma.journalEntry.create({
        data: {
          date: parseBizDate("2026-11-05"), memo: "lệch", source: "ADJUST", createdBy: "test",
          lines: { create: [{ accountCode: "101", debitVnd: 100n }, { accountCode: "699", creditVnd: 99n }] },
        },
      }),
    ).rejects.toThrow(/lech/);
  });

  it("không cho xoá giao dịch tiền", async () => {
    const any = await prisma.cashTxn.findFirstOrThrow();
    await expect(prisma.cashTxn.delete({ where: { id: any.id } })).rejects.toThrow(/Khong duoc xoa/);
  });

  it("không cho sửa dòng bút toán đã ghi", async () => {
    const line = await prisma.journalLine.findFirstOrThrow();
    await expect(prisma.journalLine.update({ where: { id: line.id }, data: { shopId: "x" } })).rejects.toThrow(/khong duoc sua/);
  });
});
