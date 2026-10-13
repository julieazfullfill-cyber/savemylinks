// GĐ3 — các con số lấy đúng từ self-test của đặc tả (số liệu tháng 8/2026, Team 1).
import { describe, expect, it } from "vitest";
import { parseBizDate as d } from "@/lib/dates";
import { allocateByRevenue, breakEvenRevenue, groupMargin, orderMargin, type MarginRow } from "@/lib/margin";
import { runOrderAlerts } from "@/lib/order-alerts";
import { normalizeOrders, parseCsv, parseDate, parseMoney } from "@/lib/order-import";
import { payoutsByWeek, projectPayouts, reconcilePayout } from "@/lib/payout";

const rev = (grossUsd: number) => ({ grossUsd, discountUsd: 0, shippingChargedUsd: 0, platformFeeUsd: 0, taxUsd: 0 });
const ff = (ffUsd: number) => ({ ffUsd, shipUsd: 0, designUsd: 0, adsUsd: 0, overheadUsd: 0 });
const AUG: MarginRow[] = [
  { key: "Etsy", revenue: rev(43_030), costs: ff(25_082 + 2_496 + 1_259) },
  { key: "Amazon", revenue: rev(14_632), costs: ff(12_624) },
  { key: "Khac", revenue: rev(231), costs: ff(0) },
];

describe("biên lãi", () => {
  it("gộp nhóm tháng 8: Etsy FF 67%, Amazon 86,3%", () => {
    const g = groupMargin(AUG);
    expect(g.map((x) => [x.key, x.ffUsd, Math.round(x.ffRatio * 1000) / 10, x.grossProfitUsd])).toEqual([
      ["Etsy", 28_837, 67, 14_193],
      ["Amazon", 12_624, 86.3, 2_008],
      ["Khac", 0, 0, 231],
    ]);
  });
  it("hoà vốn: FF 71,6% cần $69.808, FF 65% cần $56.611", () => {
    const rev = AUG.reduce((a, r) => a + r.revenue.grossUsd, 0);
    const ffTotal = AUG.reduce((a, r) => a + r.costs.ffUsd, 0);
    expect(rev).toBe(57_893);
    expect(Math.round((ffTotal / rev) * 1000) / 10).toBe(71.6);
    expect(Math.round(breakEvenRevenue(19_814, ffTotal / rev))).toBe(69_808);
    expect(Math.round(breakEvenRevenue(19_814, 0.65))).toBe(56_611);
  });
  it("biên lãi một đơn trừ cả chi phí chung; phân bổ theo doanh thu", () => {
    const m = orderMargin({ grossUsd: 42.95, discountUsd: 0, shippingChargedUsd: 0, platformFeeUsd: 2.18, taxUsd: 3.44 }, { ffUsd: 20, shipUsd: 5, designUsd: 0, adsUsd: 0, overheadUsd: 4 });
    expect(m).toMatchObject({ netRevenueUsd: 37.33, grossProfitUsd: 12.33, netProfitUsd: 8.33 });
    expect(allocateByRevenue([300, 100, 0], 40)).toEqual([30, 10, 0]);
  });
});

describe("import CSV", () => {
  const csv = [
    "Sale Date,Order ID,Ship Country,Order Value,Shipping,Card Processing Fees,Sales Tax,SKU,Quantity",
    '08/14/2026,3412887001,United States,"$42.95","$0.00","$2.18","$3.44",ORN-XMAS-01,2',
    '08/15/2026,3412887002,"Smith, John",”bad”,"$0.00","$0.00","$0.00",ORN-XMAS-02,1',
    '08/15/2026,3412887003,Canada,"$1,230.00","$12.00","$58.40","$0.00",TSHIRT-A,1',
    'khong-phai-ngay,3412887004,US,"$10.00",,,,SKU-X,1',
  ].join("\n");

  it("self-test Etsy: 3 đơn, 2 cảnh báo (doanh thu 0, ngày hỏng)", () => {
    const res = normalizeOrders("ETSY", parseCsv(csv));
    expect(res.orders.map((o) => [o.externalId, o.orderedAt, o.grossUsd, o.netUsd])).toEqual([
      ["3412887001", "2026-08-14", 42.95, 37.33],
      ["3412887002", "2026-08-15", 0, 0],
      ["3412887003", "2026-08-15", 1230, 1183.6],
    ]);
    expect(res.errors.map((e) => [e.row, e.field]).sort()).toEqual([[3, "grossUsd"], [5, "orderedAt"]]);
  });

  it("parseMoney, parseDate (không đảo tháng/ngày)", () => {
    expect(parseMoney("$1,234.56")).toBe(1234.56);
    expect(parseMoney("(12.00)")).toBe(-12);
    expect(parseDate("08/14/2026")).toBe("2026-08-14");
    expect(parseDate("2026-08-14T10:00:00Z")).toBe("2026-08-14");
    expect(parseDate("14/08/2026")).toBeNull(); // tháng 14 không tồn tại — không đoán bừa
  });

  it("đơn nhiều dòng: gộp thành nhiều mặt hàng; cột cấp mặt hàng cộng dồn, cột cấp đơn lấy một lần", () => {
    const amz = normalizeOrders(
      "AMAZON",
      parseCsv("amazon-order-id\tpurchase-date\titem-price\tsku\tquantity-purchased\nA-1\t2026-08-01\t20.00\tSKU-1\t1\nA-1\t2026-08-01\t15.50\tSKU-2\t2"),
    );
    expect(amz.orders).toHaveLength(1);
    expect(amz.orders[0].grossUsd).toBe(35.5);
    expect(amz.orders[0].items.map((i) => [i.sku, i.qty])).toEqual([["SKU-1", 1], ["SKU-2", 2]]);

    const tt = normalizeOrders(
      "TIKTOK",
      parseCsv("Order ID,Created Time,Order Amount,Seller SKU\nT-9,2026-08-02,50.00,A\nT-9,2026-08-02,50.00,B"),
    );
    expect(tt.orders[0].grossUsd).toBe(50); // "Order Amount" lặp lại mỗi dòng — không cộng hai lần
    expect(tt.orders[0].items).toHaveLength(2);
  });

  it("thiếu cột bắt buộc → báo tên khả dĩ", () => {
    const r = normalizeOrders("WALMART", parseCsv("Foo,Bar\n1,2"));
    expect(r.errors[0].message).toMatch(/PO#/);
  });
});

describe("đối soát payout", () => {
  it("self-test: khớp $750, không khớp $210, lệch $0", () => {
    const r = reconcilePayout(
      { id: "PO-08-01", grossUsd: 1000, feeUsd: 40, netUsd: 960 },
      [
        { orderId: "o1", amountUsd: 400, kind: "ORDER" },
        { orderId: "o2", amountUsd: 350, kind: "ORDER" },
        { orderId: "o9", amountUsd: 150, kind: "ORDER" },
        { orderId: null, amountUsd: 60, kind: "ADJUST" },
      ],
      new Set(["o1", "o2", "o3"]),
    );
    expect(r).toMatchObject({ matchedUsd: 750, unmatchedUsd: 210, diffUsd: 0, balanced: true, unknownOrderIds: ["o9"] });
  });

  it("lệch nhỏ trong ngưỡng 1% vẫn đóng được", () => {
    const r = reconcilePayout({ id: "x", grossUsd: 0, feeUsd: 0, netUsd: 1000 }, [{ orderId: null, amountUsd: 995, kind: "ORDER" }], new Set());
    expect(r).toMatchObject({ balanced: false, withinTolerance: true, diffUsd: -5 });
  });

  it("self-test: lịch tiền về Etsy 12/11, Amazon 23/11; gộp theo tuần", () => {
    const from = d("2026-11-02");
    const p = projectPayouts(
      [
        { channel: "ETSY", date: d("2026-11-03"), netUsd: 9_938 },
        { channel: "AMAZON", date: d("2026-11-03"), netUsd: 7_316 },
      ],
      from,
    );
    expect(p.map((x) => [x.channel, x.expectedOn.toISOString().slice(0, 10)])).toEqual([
      ["ETSY", "2026-11-12"],
      ["AMAZON", "2026-11-23"],
    ]);
    expect(payoutsByWeek(p, [d("2026-11-09"), d("2026-11-16"), d("2026-11-23")])).toEqual([9_938, 0, 7_316]);
  });
});

describe("cảnh báo", () => {
  it("self-test tháng 8: 3 lỗi (FF, tập trung, giá Merchize) + đơn chưa khớp + tiền chưa về", () => {
    const a = runOrderAlerts({
      netRevenueUsd: 57_893,
      ffUsd: 41_461,
      fixedCostUsd: 19_814,
      byAccount: [
        { code: "AWHK", name: "Airwallex HK", usd: 39_996 },
        { code: "AMZ-AU1", name: "Amazon AU1", usd: 12_576 },
        { code: "BANKVN", name: "Bank Việt", usd: 1_485 },
        { code: "BANKRIENG", name: "Bank riêng khác", usd: 1_548 },
      ],
      fulfillments: [
        { supplierName: "Merchize", sku: "ORN-XMAS-01", costUsd: 25_082, listedCostUsd: 21_019 },
        { supplierName: "Printify", sku: "TSHIRT-A", costUsd: 2_496, listedCostUsd: 2_450 },
      ],
      orders: [
        { externalId: "3412887001", orderedAt: d("2026-08-14"), hasFulfillment: true },
        { externalId: "3412887003", orderedAt: d("2026-08-15"), hasFulfillment: false },
      ],
      receivedUsd: 38_000,
      now: d("2026-08-20"),
    });
    expect(a.map((x) => [x.level, x.code])).toEqual([
      ["error", "FF_RATIO"],
      ["error", "CONCENTRATION"],
      ["error", "PRICE_VARIANCE"],
      ["warn", "UNMATCHED_ORDER"],
      ["info", "CASH_GAP"],
    ]);
    expect(a[0].detail).toMatch(/\$69,808/);
    expect(a[1].title).toMatch(/71,9%/);
    expect(a[2].title).toMatch(/19,3%/);
  });
});
