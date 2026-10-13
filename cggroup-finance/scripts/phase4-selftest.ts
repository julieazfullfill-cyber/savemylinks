// Tự kiểm giai đoạn 4 — đặc tả mục 07. Số liệu tháng 8/2026, GIỮ NGUYÊN các lỗi có thật trong file gốc
// để chứng minh hệ thống tự tìm ra chúng. Chạy: npm run phase4:selftest

import { allocationTable } from "../src/lib/allocation";
import { blocksClosing, runDataChecks } from "../src/lib/datachecks";
import { balanceSheet, profitAndLoss, trialBalance, type AccountType, type LineRow } from "../src/lib/gl";
import { formatMoney as vnd } from "../src/lib/money";
import { buildClosingJournal, canClose, closeChecklist } from "../src/lib/period-close";

const line = (s = "") => console.log(s);
const R = 26_060n;
const L = (code: string, name: string, type: AccountType, debit: bigint, credit: bigint): LineRow => ({
  accountCode: code,
  accountName: name,
  accountType: type,
  debitVnd: debit,
  creditVnd: credit,
});

// Sổ cái tháng 8/2026 Team 1, quy VND theo tỷ giá 26.060
const rev = 57_892n * R;
const ff = 41_461n * R;
const payroll = 325_678_314n;
const bhxh = 20_745_563n;
const office = 21_040_721n;
const fees = 9_250_000n;
const misc = 50_427_555n;
const tiktok = 43_903_308n;
const totalExp = payroll + bhxh + office + fees + misc + tiktok;

const lines: LineRow[] = [
  L("111", "So du tren san", "ASSET", rev, 0n),
  L("401", "Doanh thu Etsy", "REVENUE", 0n, rev),
  L("501", "Chi phi fulfillment", "COGS", ff, 0n),
  L("201", "Phai tra NCC", "LIABILITY", 0n, ff),
  L("601", "Luong", "EXPENSE", payroll, 0n),
  L("602", "BHXH cong ty", "EXPENSE", bhxh, 0n),
  L("603", "Thue van phong", "EXPENSE", office, 0n),
  L("503", "Phi san", "COGS", fees, 0n),
  L("699", "Chi phi khac", "EXPENSE", misc + tiktok, 0n),
  L("102", "Ngan hang VND", "ASSET", 0n, totalExp),
];

line("=== 1. BANG CAN DOI THU ===");
const tb = trialBalance(lines);
for (const r of tb.rows) line(`  ${r.accountCode}  ${r.accountName.padEnd(22)} no ${vnd(r.debitVnd).padStart(18)}  co ${vnd(r.creditVnd).padStart(18)}`);
line(`  ${"".padEnd(26)} TONG ${vnd(tb.totalDebitVnd).padStart(18)}     ${vnd(tb.totalCreditVnd).padStart(18)}`);
line(`  Can: ${tb.balanced ? "CO" : "KHONG — lech " + vnd(tb.diffVnd)}`);

line();
line("=== 2. P&L QUAN TRI — sinh tu so cai ===");
const pnl = profitAndLoss(lines);
line(`  Doanh thu        ${vnd(pnl.revenueVnd).padStart(18)}`);
line(`  Gia von          ${vnd(pnl.cogsVnd).padStart(18)}`);
line(`  Lai gop          ${vnd(pnl.grossProfitVnd).padStart(18)}   bien ${(pnl.grossMarginPct * 100).toFixed(1)}%`);
line(`  Chi phi hoat dong${vnd(pnl.expenseVnd).padStart(18)}`);
line(`  LOI NHUAN        ${vnd(pnl.netProfitVnd).padStart(18)}   bien ${(pnl.netMarginPct * 100).toFixed(1)}%`);
const bs = balanceSheet(lines);
line(`  Can doi: tai san ${vnd(bs.assetsVnd)} = no ${vnd(bs.liabilitiesVnd)} + lai lo ${vnd(bs.retainedThisPeriodVnd)} -> ${bs.balanced ? "CAN" : "LECH " + vnd(bs.diffVnd)}`);

line();
line("=== 3. PHAN BO CHI PHI CHUNG theo ty trong doanh thu ===");
const pool = office + fees + misc;
const alloc = allocationTable(
  pool,
  [
    { id: "etsy", name: "Etsy", revenueVnd: 43_030n * R },
    { id: "amz", name: "Amazon", revenueVnd: 14_632n * R },
    { id: "khac", name: "Khac", revenueVnd: 231n * R },
  ],
  "REVENUE",
);
for (const a of alloc.lines) line(`  ${a.targetName.padEnd(8)} ${(a.sharePct * 100).toFixed(1).padStart(5)}%  ${vnd(a.amountVnd).padStart(16)}`);
line(`  Tong phan bo ${vnd(alloc.totalVnd)} / pool ${vnd(pool)} -> khop tung dong: ${alloc.exact}`);

line();
line("=== 4. BO KIEM TRA — du lieu CO LOI nhu file goc ===");
const checks = runDataChecks({
  payrollTotalVnd: 325_678_314n, // file gốc ghi 311.672.191
  ledgerSalaryVnd: 311_672_191n,
  cashAccounts: [
    { code: "102", name: "Ngan hang VND", ledgerVnd: 500_000_000n, statementVnd: 500_000_000n },
    { code: "AWHK", name: "Airwallex HK", ledgerVnd: 234_540_000n, statementVnd: null },
  ],
  suppliers: [{ name: "Merchize", billedVnd: 982_400_000n, fulfillmentVnd: 900_000_000n }],
  magnitudeChecks: [{ label: "Team 2 — chi phi luong", currentVnd: 39_250n, priorVnd: [41_173_913n, 38_625_000n, 39_000_000n] }],
  totalOrders: 1240,
  ordersWithCost: 1120,
  netProfitVnd: pnl.netProfitVnd,
  bonusPaidVnd: 64_547_161n,
  trialDiffVnd: tb.diffVnd,
});
for (const c of checks) {
  line(`  [${c.level.padEnd(5)}] ${c.code}`);
  line(`          ${c.detail}`);
}

line();
line("=== 5. DONG SO ===");
const steps = closeChecklist({
  payoutsReconciled: true,
  cashStatementsEntered: false,
  allocationsPosted: true,
  attendanceApproved: true,
  payrollClosed: true,
  checks,
});
for (const s of steps) line(`  ${s.done ? "[x]" : "[ ]"} ${s.code}${s.blocking ? "" : "  (khong chan)"}${s.detail ? " — " + s.detail : ""}`);
const ok = canClose(steps, checks);
line(`  => ${ok ? "DUOC dong so" : "CHUA duoc dong so"}`);

line();
line("=== 6. BUT TOAN KET CHUYEN LAI LO ===");
const closing = buildClosingJournal(pnl);
let d = 0n;
let c = 0n;
for (const l of closing) {
  d += l.debitVnd;
  c += l.creditVnd;
  line(`  ${l.accountCode}  no ${vnd(l.debitVnd).padStart(18)}  co ${vnd(l.creditVnd).padStart(18)}`);
}
line(`  ----  tong no ${vnd(d)} = tong co ${vnd(c)}`);

line();
const errs = checks.filter((x) => x.level === "ERROR").length;
const expected =
  tb.totalDebitVnd === 3_060_184_641n &&
  pnl.netProfitVnd === -42_853_601n &&
  alloc.lines.map((a) => a.amountVnd).join() === "59995292,20400909,322075" &&
  checks.map((x) => x.code).join() === "PAYROLL_LEDGER,MAGNITUDE,ORDER_NO_COST,CASH_NO_STATEMENT,SUPPLIER_BILL,BONUS_IN_LOSS" &&
  d === 1_551_519_121n &&
  !ok;
if (tb.balanced && bs.balanced && alloc.exact && d === c && errs >= 3 && blocksClosing(checks) && expected) {
  line(`OK — so cai can, phan bo khop tung dong, bo kiem tra tu tim ra ${errs} loi (co dung hai loi that cua file goc thang 8).`);
} else {
  console.error("THIEU dieu kien mong doi");
  process.exit(1);
}
