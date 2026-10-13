// Tự kiểm GĐ3 bằng số liệu THẬT tháng 8/2026 của Team 1 — đặc tả GĐ3 mục 08.
// Chạy: npm run phase3:selftest
import { parseBizDate as d } from "../src/lib/dates";
import { breakEvenRevenue, groupMargin, type MarginRow } from "../src/lib/margin";
import { runOrderAlerts } from "../src/lib/order-alerts";
import { normalizeOrders, parseCsv, parseDate, parseMoney } from "../src/lib/order-import";
import { projectPayouts, reconcilePayout } from "../src/lib/payout";

const line = (s = "") => console.log(s);
const usd = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
const pct = (v: number) => (v * 100).toFixed(1) + "%";
const rev = (grossUsd: number) => ({ grossUsd, discountUsd: 0, shippingChargedUsd: 0, platformFeeUsd: 0, taxUsd: 0 });
const ff = (ffUsd: number) => ({ ffUsd, shipUsd: 0, designUsd: 0, adsUsd: 0, overheadUsd: 0 });

line("=== 1. BIEN LAI — so lieu thang 8/2026 ===");
const rows: MarginRow[] = [
  { key: "Etsy", revenue: rev(43_030), costs: ff(25_082 + 2_496 + 1_259) },
  { key: "Amazon", revenue: rev(14_632), costs: ff(12_624) },
  { key: "Khac", revenue: rev(231), costs: ff(0) },
];
for (const g of groupMargin(rows)) {
  line(`  ${g.key.padEnd(8)} doanh thu ${usd(g.netRevenueUsd).padStart(9)} | FF ${usd(g.ffUsd).padStart(9)} (${pct(g.ffRatio).padStart(6)}) | lai gop ${usd(g.grossProfitUsd).padStart(9)}`);
}
const totalRev = rows.reduce((a, r) => a + r.revenue.grossUsd, 0);
const totalFf = rows.reduce((a, r) => a + r.costs.ffUsd, 0);
const fixedCost = 19_814;
line();
line(`  Tong: doanh thu ${usd(totalRev)}, FF ${usd(totalFf)} = ${pct(totalFf / totalRev)}`);
line(`  Hoa von o muc FF nay can ${usd(breakEvenRevenue(fixedCost, totalFf / totalRev))}/thang`);
line(`  Neu keo FF ve 65%   can ${usd(breakEvenRevenue(fixedCost, 0.65))}/thang`);

line();
line("=== 2. IMPORT CSV — dinh dang Etsy ===");
const csv = [
  "Sale Date,Order ID,Ship Country,Order Value,Shipping,Card Processing Fees,Sales Tax,SKU,Quantity",
  '08/14/2026,3412887001,United States,"$42.95","$0.00","$2.18","$3.44",ORN-XMAS-01,2',
  '08/15/2026,3412887002,"Smith, John",”bad”,"$0.00","$0.00","$0.00",ORN-XMAS-02,1',
  '08/15/2026,3412887003,Canada,"$1,230.00","$12.00","$58.40","$0.00",TSHIRT-A,1',
  'khong-phai-ngay,3412887004,US,"$10.00",,,,SKU-X,1',
].join("\n");
const parsed = parseCsv(csv);
const res = normalizeOrders("ETSY", parsed);
line(`  Doc ${parsed.length - 1} dong -> ${res.orders.length} don, ${res.errors.length} canh bao`);
for (const o of res.orders) line(`    ${o.externalId}  ${o.orderedAt}  gross ${usd(o.grossUsd).padStart(7)}  net ${usd(o.netUsd).padStart(7)}  ${o.items[0].sku}`);
for (const e of res.errors) line(`    ! dong ${e.row} [${e.field}] ${e.message}`);
line(`  parseMoney("$1,234.56") = ${parseMoney("$1,234.56")}   parseMoney("(12.00)") = ${parseMoney("(12.00)")}`);
line(`  parseDate("08/14/2026") = ${parseDate("08/14/2026")}`);

line();
line("=== 3. DOI SOAT PAYOUT ===");
const rec = reconcilePayout(
  { id: "PO-08-01", grossUsd: 1000, feeUsd: 40, netUsd: 960 },
  [
    { orderId: "o1", amountUsd: 400, kind: "ORDER" },
    { orderId: "o2", amountUsd: 350, kind: "ORDER" },
    { orderId: "o9", amountUsd: 150, kind: "ORDER" },
    { orderId: null, amountUsd: 60, kind: "ADJUST" },
  ],
  new Set(["o1", "o2", "o3"]),
);
line(`  khop ${usd(rec.matchedUsd)} | khong khop ${usd(rec.unmatchedUsd)} | lech ${usd(rec.diffUsd)} | can: ${rec.balanced}`);
line(`  don la: ${rec.unknownOrderIds.join(", ") || "(khong)"}`);
const proj = projectPayouts(
  [
    { channel: "ETSY", date: d("2026-11-03"), netUsd: 9_938 },
    { channel: "AMAZON", date: d("2026-11-03"), netUsd: 7_316 },
  ],
  d("2026-11-02"),
);
line("  Lich tien ve du kien:");
for (const p of proj) line(`    ${p.channel.padEnd(7)} ${p.expectedOn.toISOString().slice(0, 10)}  ${usd(p.amountUsd)}`);

line();
line("=== 4. CANH BAO TU DONG ===");
const alerts = runOrderAlerts({
  netRevenueUsd: totalRev,
  ffUsd: totalFf,
  fixedCostUsd: fixedCost,
  byAccount: [
    { code: "AWHK", name: "Airwallex HK", usd: 39_996 },
    { code: "AMZ-AU1", name: "Amazon AU1", usd: 12_576 },
    { code: "BANKVN", name: "Bank Viet", usd: 1_485 },
    { code: "BANKRIENG", name: "Bank rieng khac", usd: 1_548 },
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
for (const a of alerts) {
  line(`  [${a.level.toUpperCase().padEnd(5)}] ${a.title}`);
  line(`          ${a.detail}`);
}
line();
if (alerts.filter((a) => a.level === "error").length >= 2) line("OK — cac kiem tra bat dung ca hai rui ro da phat hien thang 8.");
else {
  console.error("THIEU canh bao mong doi");
  process.exit(1);
}
