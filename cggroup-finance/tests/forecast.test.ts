import { describe, expect, it } from "vitest";
import { buildForecast, firstWeekBelow, type ForecastInput } from "@/lib/forecast";
import { parseBizDate as d } from "@/lib/dates";
import { startOfWeek } from "@/lib/dates";

const base = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  startDate: d("2026-11-02"), // thứ Hai
  scenario: { name: "base", revenueFactor: 1, ffRate: 0 },
  openingAvailableVnd: 1_000_000_000n,
  reserves: [],
  channels: [],
  suppliers: [],
  bills: [],
  recurring: [],
  manualItems: [],
  ...over,
});

describe("buildForecast", () => {
  it("13 tuần, tuần bắt đầu thứ Hai, closing nối sang opening", () => {
    const rows = buildForecast(base({ startDate: d("2026-11-04") }));
    expect(rows).toHaveLength(13);
    expect(rows[0].from).toEqual(d("2026-11-02"));
    expect(rows[0].to).toEqual(d("2026-11-08"));
    for (let i = 1; i < rows.length; i++) expect(rows[i].opening).toBe(rows[i - 1].closing);
  });

  it("reserve chỉ vào đúng tuần releaseOn, không cộng vào số dư mở đầu", () => {
    const rows = buildForecast(base({ reserves: [{ releaseOn: d("2026-11-18"), amountVnd: 50_000_000n }] }));
    expect(rows[0].opening).toBe(1_000_000_000n);
    expect(rows[2].reserveIn).toBe(50_000_000n);
    expect(rows.filter((r) => r.reserveIn > 0n)).toHaveLength(1);
  });

  it("chi phí định kỳ rơi đúng tuần chứa ngày đến hạn, không chia đều", () => {
    const rows = buildForecast(base({ recurring: [{ label: "Lương", dueDay: 10, amountVnd: 300_000_000n }] }));
    const hit = rows.filter((r) => r.fixedOut > 0n);
    // 10/11, 10/12, 10/01 trong 13 tuần từ 02/11
    expect(hit.map((r) => r.week)).toEqual([2, 6, 10]);
    expect(hit.every((r) => r.fixedOut === 300_000_000n)).toBe(true);
  });

  it("ngày 31 kẹp về cuối tháng ngắn", () => {
    const rows = buildForecast(base({ recurring: [{ label: "Thuê VP", dueDay: 31, amountVnd: 1n }] }));
    const dates = rows.filter((r) => r.fixedOut > 0n).map((r) => r.week);
    expect(dates).toEqual([5, 9, 13]); // 30/11, 31/12, 31/01
  });

  it("hoá đơn quá hạn dồn vào tuần 1", () => {
    const rows = buildForecast(
      base({
        bills: [
          { dueDate: d("2026-10-20"), outstandingVnd: 7n },
          { dueDate: d("2026-11-05"), outstandingVnd: 3n },
          { dueDate: d("2026-11-12"), outstandingVnd: 11n },
        ],
      }),
    );
    expect(rows[0].billsOut).toBe(10n);
    expect(rows[1].billsOut).toBe(11n);
  });

  it("payout theo chu kỳ kênh: Amazon 14 ngày rơi cách tuần", () => {
    const rows = buildForecast(
      base({
        channels: [{ channel: "AMAZON", monthlyVnd: 365_000_000n, payoutEveryDays: 14, anchor: d("2026-11-03") }],
      }),
    );
    const weeks = rows.filter((r) => r.revenueIn > 0n).map((r) => r.week);
    expect(weeks).toEqual([1, 3, 5, 7, 9, 11, 13]);
    // mỗi payout = monthly × 12 × 14 / 365 = 168.000.000
    expect(rows[0].revenueIn).toBe(168_000_000n);
  });

  it("giá vốn: NCC trả trước trừ ngay, NCC công nợ 30 ngày lùi 4 tuần", () => {
    const channels = [{ channel: "ETSY", monthlyVnd: 520_000_000n, payoutEveryDays: 7, anchor: d("2026-11-06") }];
    const scenario = { name: "x", revenueFactor: 1, ffRate: 0.5 };
    const prepaid = buildForecast(base({ channels, scenario, suppliers: [{ code: "A", share: 1, prepaid: true, creditDays: 0 }] }));
    expect(prepaid[0].cogsOut).toBe(60_000_000n); // 520tr × 12/52 × 0.5

    const credit = buildForecast(base({ channels, scenario, suppliers: [{ code: "A", share: 1, prepaid: false, creditDays: 30 }] }));
    expect(credit.slice(0, 4).every((r) => r.cogsOut === 0n)).toBe(true);
    expect(credit[4].cogsOut).toBe(60_000_000n);
  });

  it("kịch bản doanh thu giảm làm giảm tiền vào tương ứng", () => {
    const channels = [{ channel: "ETSY", monthlyVnd: 365_000_000n, payoutEveryDays: 7, anchor: d("2026-11-06") }];
    const a = buildForecast(base({ channels }));
    const b = buildForecast(base({ channels, scenario: { name: "bad", revenueFactor: 0.8, ffRate: 0 } }));
    expect(b[0].revenueIn * 10n).toBe(a[0].revenueIn * 8n);
  });

  it("khoản thu nhập tay nhân độ chắc chắn, khoản chi tính đủ", () => {
    const rows = buildForecast(
      base({
        manualItems: [
          { expectedOn: d("2026-11-03"), direction: "IN", amountVnd: 100n, confidence: 50, recurring: null },
          { expectedOn: d("2026-11-03"), direction: "OUT", amountVnd: 100n, confidence: 50, recurring: "WEEKLY" },
        ],
      }),
    );
    expect(rows[0].manualIn).toBe(50n);
    expect(rows.every((r) => r.manualOut === 100n)).toBe(true);
  });

  it("firstWeekBelow tìm tuần chạm đáy", () => {
    const rows = buildForecast(base({ openingAvailableVnd: 100n, recurring: [{ label: "x", dueDay: 10, amountVnd: 80n }] }));
    expect(firstWeekBelow(rows, 50n)?.week).toBe(2);
  });

  it("startOfWeek", () => expect(startOfWeek(d("2026-11-08"))).toEqual(d("2026-11-02")));
});
