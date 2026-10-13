import { describe, expect, it } from "vitest";
import { buildPnl, parseLegacyCsv, type LedgerRow } from "@/lib/pnl";

const r = (month: string, accountCode: string, type: LedgerRow["type"], debit: bigint, credit: bigint): LedgerRow => ({
  month, accountCode, accountName: accountCode, type, debit, credit,
});

describe("buildPnl", () => {
  it("doanh thu − giá vốn − chi phí + khác; bỏ qua tài khoản bảng cân đối", () => {
    const p = buildPnl([
      r("2026-11", "402", "REVENUE", 0n, 1_000n),
      r("2026-11", "501", "COGS", 400n, 0n),
      r("2026-11", "601", "EXPENSE", 300n, 0n),
      r("2026-11", "701", "OTHER", 50n, 0n), // lỗ tỷ giá
      r("2026-11", "102", "ASSET", 999n, 0n),
      r("2026-12", "402", "REVENUE", 10n, 210n), // có hoàn trả ghi nợ doanh thu
    ]);
    expect(p.months).toEqual(["2026-11", "2026-12"]);
    expect(p.byMonth.get("2026-11")).toEqual({ revenue: 1_000n, cogs: 400n, gross: 600n, expense: 300n, other: -50n, net: 250n });
    expect(p.total.revenue).toBe(1_200n);
    expect(p.accounts.map((a) => a.code)).toEqual(["402", "501", "601", "701"]);
  });
});

describe("parseLegacyCsv", () => {
  it("bỏ dòng tiêu đề, cảnh báo khi profit sai công thức", () => {
    const rows = parseLegacyCsv("team,year,month,revenueUsd,expenseUsd,profitUsd\nTeam 1,2026,8,10000,8000.50,1999.50\nTeam 2,2026,8,5000,4000,39.25");
    expect(rows).toHaveLength(2);
    expect(rows[0].warning).toBeNull();
    expect(rows[1].warning).toMatch(/≠/);
  });
  it("từ chối số sai định dạng", () => {
    expect(() => parseLegacyCsv("T1,2026,8,10.000,1,1")).toThrow(/không hợp lệ/);
    expect(() => parseLegacyCsv("T1,2026,13,1,1,0")).toThrow(/tháng/);
  });
});
