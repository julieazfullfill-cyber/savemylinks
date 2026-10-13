import { vi } from "vitest";

// Schema riêng của file này (xem tests/global-setup.ts) — phải chạy trước khi Prisma kết nối.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DB_URL_IMPORT;
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { checkHeaders, importSheet, parseCsv } from "@/lib/import-1a";
import { seedCatalog } from "../prisma/seed-data";

beforeAll(async () => {
  await seedCatalog(prisma);
  await prisma.fxRate.create({ data: { date: d("2026-11-01"), base: "USD", quote: "VND", rate: "25000" } });
  await prisma.shop.create({ data: { code: "AMZ-AU1", name: "Amazon AU1", channel: "AMAZON" } });
});
afterAll(() => prisma.$disconnect());

const GD = [
  "date\taccountCode\tdirection\tamount\tcurrency\tfxRate\tcategoryCode\tsupplierCode\tshopCode\tdescription",
  "2026-11-02\tAWHK\tIN\t1.250,50\tUSD\t\t\t\tAMZ-AU1\tPayout AMZ",
  "2026-11-03\tBANKVN\tOUT\t2.000.000\tVND\t\tVPS_TOOL\t\t\tVPS tháng 11",
  "2026-11-03\tKHONGCO\tOUT\t1\tVND\t\t\t\t\tsai TK",
  "2026-11-04\tAWHK\tOUT\t10\tUSD\t\t\t\t\tthiếu tỷ giá? không, có từ 01/11",
].join("\n");

describe("nhập sheet 1a", () => {
  it("đọc TSV dán từ Google Sheets, kiểm cột bắt buộc", () => {
    const { headers, rows } = parseCsv(GD);
    expect(rows).toHaveLength(4);
    expect(() => checkHeaders("GD_Tien", headers)).not.toThrow();
    expect(() => checkHeaders("HD_NCC", headers)).toThrow(/thiếu cột: issueDate$/);
    expect(parseCsv('a,b\n"x, y",2').rows[0].cells.a).toBe("x, y");
  });

  it("GD_Tien: dòng sai báo lỗi nhưng không làm hỏng dòng khác; chạy lại thì bỏ qua dòng đã nạp", async () => {
    const { rows } = parseCsv(GD);
    const r1 = await prisma.$transaction((tx) => importSheet(tx, "GD_Tien", rows, "kt"));
    expect(r1.map((r) => r.status)).toEqual(["ok", "ok", "error", "ok"]);
    expect(r1[2].message).toMatch(/KHONGCO/);
    const amz = await prisma.cashTxn.findFirstOrThrow({ where: { description: "Payout AMZ" }, include: { journal: { include: { lines: true } } } });
    expect(amz.amount).toBe(125_050n);
    expect(amz.journal!.lines.map((l) => l.accountCode).sort()).toEqual(["103", "402"]); // thu từ shop Amazon → 402

    const r2 = await prisma.$transaction((tx) => importSheet(tx, "GD_Tien", rows, "kt"));
    expect(r2.map((r) => r.status)).toEqual(["skip", "skip", "error", "skip"]);
  });

  it("HD_NCC và Chi_Phi", async () => {
    const hd = parseCsv("supplierCode,billNo,issueDate,dueDate,amount,currency\nMERCHIZE,M-77,2026-11-05,,500,USD").rows;
    expect((await prisma.$transaction((tx) => importSheet(tx, "HD_NCC", hd, "kt")))[0].status).toBe("ok");
    expect((await prisma.$transaction((tx) => importSheet(tx, "HD_NCC", hd, "kt")))[0].status).toBe("skip");

    const cp = parseCsv("date;categoryCode;amount;description;status\n2026-11-06;THUE_VP;20.000.000;Thuê VP T11;APPROVED\n2026-11-06;THUE_VP;1;x;PAID").rows;
    const r = await prisma.$transaction((tx) => importSheet(tx, "Chi_Phi", cp, "kt"));
    expect(r.map((x) => x.status)).toEqual(["ok", "error"]);
    expect((await prisma.expense.findFirstOrThrow({ where: { description: "Thuê VP T11" } })).status).toBe("APPROVED");
  });
});
