import { describe, expect, it } from "vitest";
import { parseBizDate as d } from "@/lib/dates";
import { balanceSeries, bookBalance, buildAlerts, compactVnd, flows, niceTicks, rateOn, type AlertInput, type LedgerTxn } from "@/lib/overview";

const txns: LedgerTxn[] = [
  { accountId: "bank", date: d("2026-11-01"), direction: "IN", amount: 100_000_000n, currency: "VND" },
  { accountId: "aw", date: d("2026-11-02"), direction: "IN", amount: 100_000n, currency: "USD" }, // 1.000 $
  { accountId: "bank", date: d("2026-11-03"), direction: "OUT", amount: 30_000_000n, currency: "VND" },
];
const rates = [
  { date: d("2026-11-02"), rate: "25000" },
  { date: d("2026-11-04"), rate: "26000" },
];

describe("số dư", () => {
  it("bookBalance tại ngày", () => {
    expect(bookBalance(txns, "bank")).toBe(70_000_000n);
    expect(bookBalance(txns, "bank", d("2026-11-02"))).toBe(100_000_000n);
  });

  it("rateOn lấy tỷ giá gần nhất trước hoặc trong ngày", () => {
    expect(rateOn(rates, d("2026-11-01"))).toBeNull();
    expect(rateOn(rates, d("2026-11-03"))).toBe("25000");
    expect(rateOn(rates, d("2026-11-09"))).toBe("26000");
  });

  it("chuỗi theo ngày, USD định giá theo tỷ giá của chính ngày đó", () => {
    const s = balanceSeries(txns, rates, d("2026-10-31"), d("2026-11-04"));
    expect(s.map((x) => [x.date, x.vnd])).toEqual([
      ["2026-10-31", 0n],
      ["2026-11-01", 100_000_000n],
      ["2026-11-02", 125_000_000n],
      ["2026-11-03", 95_000_000n],
      ["2026-11-04", 96_000_000n], // tỷ giá tăng → giá trị USD tăng, không có giao dịch
    ]);
  });

  it("USD chưa có tỷ giá → đánh dấu missingRate", () => {
    const s = balanceSeries([{ ...txns[1], date: d("2026-11-01") }], rates, d("2026-11-01"), d("2026-11-02"));
    expect(s.map((x) => x.missingRate)).toEqual([true, false]);
  });

  it("thu chi trong khoảng, bỏ số dư đầu kỳ", () => {
    const f = flows(
      [
        { date: d("2026-11-01"), direction: "IN", amountVnd: 500n, opening: true },
        { date: d("2026-11-02"), direction: "IN", amountVnd: 100n, opening: false },
        { date: d("2026-11-03"), direction: "OUT", amountVnd: 40n, opening: false },
        { date: d("2026-12-01"), direction: "OUT", amountVnd: 9n, opening: false },
      ],
      d("2026-11-01"),
      d("2026-11-30"),
    );
    expect(f).toEqual({ inflow: 100n, outflow: 40n, net: 60n });
  });
});

describe("cảnh báo", () => {
  const acc = (o: Partial<AlertInput["accounts"][number]> = {}) => ({
    id: "a", code: "AWHK", label: "Airwallex HK", currency: "USD" as const, book: 1n, txnCount: 1, hasOpening: true, ...o,
  });
  const base: AlertInput = { today: d("2026-11-20"), accounts: [acc()], latestUsdRateDate: d("2026-11-19"), overdueBills: [] };

  it("không có gì bất thường → không cảnh báo", () => expect(buildAlerts(base)).toEqual([]));

  it("nặng xếp trước: số dư âm, hoá đơn quá hạn trước tỷ giá cũ", () => {
    const a = buildAlerts({
      ...base,
      accounts: [acc({ book: -5n })],
      latestUsdRateDate: d("2026-11-01"),
      overdueBills: [{ supplier: "Merchize", dueDate: d("2026-11-10"), outstandingVnd: 1_000_000n }],
    });
    expect(a.map((x) => [x.severity, x.title])).toEqual([
      ["crit", "Số dư âm: AWHK"],
      ["crit", "1 hoá đơn NCC quá hạn"],
      ["warn", "Tỷ giá USD cũ"],
    ]);
    expect(a[1].detail).toMatch(/10 ngày/);
  });

  it("lệch số dư chốt và sổ quỹ; thiếu số dư đầu kỳ", () => {
    const a = buildAlerts({
      ...base,
      accounts: [acc({ hasOpening: false, lastClose: { date: d("2026-11-18"), available: 1000n, bookAtDate: 900n } })],
    });
    expect(a.map((x) => x.title)).toEqual(["Lệch số dư: AWHK", "1 tài khoản chưa có số dư đầu kỳ"]);
  });

  it("chưa có giao dịch → gợi ý bắt đầu", () => {
    expect(buildAlerts({ ...base, accounts: [acc({ txnCount: 0, book: 0n })] })[0].severity).toBe("info");
  });
});

describe("định dạng trục", () => {
  it("compactVnd", () => {
    expect(compactVnd(1_250_000_000)).toBe("1,25 tỷ");
    expect(compactVnd(350_000_000)).toBe("350 tr");
    expect(compactVnd(-12_500_000)).toBe("-12,5 tr");
  });
  it("niceTicks bao trọn dải và là số tròn", () => {
    expect(niceTicks(0, 96_000_000)).toEqual([0, 25_000_000, 50_000_000, 75_000_000, 100_000_000]);
    expect(niceTicks(-30, 70)).toContain(0);
  });
});
