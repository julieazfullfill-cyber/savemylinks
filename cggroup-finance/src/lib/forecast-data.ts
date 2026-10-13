// Nạp dữ liệu thật cho buildForecast (forecast.ts) — màn hình 6.
import { CHANNELS } from "./channels";
import { addDays } from "./dates";
import type { Tx } from "./db";
import type { ForecastInput, FulfillSupplier, RevenueChannel, Scenario } from "./forecast";
import { divRound, toVnd, type Currency } from "./money";
import { bookBalance, type LedgerTxn } from "./overview";

/** Chu kỳ payout mặc định theo kênh (ngày). */
export const PAYOUT_DAYS: Record<string, number> = { AMAZON: 14, WALMART: 14, ETSY: 7, TIKTOK: 7, WEBSITE: 7 };

export type ForecastDefaults = { revenueFactor: number; ffRate: number; ffRateFromHistory: boolean };

/** Lương lấy từ kỳ lương: rơi vào ngày đến hạn của hạng mục LUONG (mặc định 10). */
export const SALARY_DUE_DAY = 10;

export async function loadForecastInput(tx: Tx, p: { startDate: Date; scenario?: Partial<Scenario> }) {
  const start = p.startDate;
  const from90 = addDays(start, -90);

  const [accounts, txns, latestRate, closes, shopIn, cogsRev, bills, billMix, suppliers, categories, items, lastPayroll] = await Promise.all([
    tx.cashAccount.findMany({ where: { active: true } }),
    tx.cashTxn.findMany({ where: { voidedAt: null }, select: { accountId: true, date: true, direction: true, amount: true, currency: true } }),
    tx.fxRate.findFirst({ where: { base: "USD", quote: "VND" }, orderBy: { date: "desc" } }),
    tx.accountBalance.findMany({ distinct: ["accountId"], orderBy: [{ accountId: "asc" }, { date: "desc" }], include: { account: true } }),
    // Thu từ shop 90 ngày: thu, có shop, không hạng mục, không phải số dư đầu kỳ
    tx.cashTxn.findMany({
      where: { voidedAt: null, direction: "IN", shopId: { not: null }, categoryId: null, date: { gte: from90, lt: start }, journal: { source: "CASH_TXN" } },
      select: { date: true, amountVnd: true, shopId: true },
    }),
    tx.journalLine.groupBy({
      by: ["accountCode"],
      where: { entry: { date: { gte: from90, lt: start } }, account: { type: { in: ["REVENUE", "COGS"] } } },
      _sum: { debitVnd: true, creditVnd: true },
    }),
    tx.supplierBill.findMany({ where: { status: { in: ["OPEN", "PARTIAL"] } }, select: { dueDate: true, amountVnd: true, paidVnd: true } }),
    tx.supplierBill.groupBy({ by: ["supplierId"], where: { issueDate: { gte: from90 } }, _sum: { amountVnd: true } }),
    tx.supplier.findMany({ where: { active: true, service: "FULFILL" } }),
    tx.expenseCategory.findMany({ where: { active: true, recurring: true, dueDay: { not: null }, budgetVnd: { not: null } } }),
    tx.forecastItem.findMany(),
    tx.payrollPeriod.findFirst({ where: { status: { in: ["APPROVED", "PAID", "CLOSED"] } }, orderBy: [{ year: "desc" }, { month: "desc" }], include: { lines: true } }),
  ]);

  const rate = latestRate?.rate.toString() ?? null;
  const vnd = (amount: bigint, cur: Currency) => (cur === "VND" ? amount : rate ? toVnd(amount, cur, rate) : 0n);

  // Số dư mở đầu = khả dụng (sổ quỹ), KHÔNG cộng phần bị giam.
  const ledger: LedgerTxn[] = txns.map((t) => ({ ...t, currency: t.currency as Currency }));
  const openingAvailableVnd = accounts.reduce((s, a) => s + vnd(bookBalance(ledger, a.id), a.currency as Currency), 0n);

  const reserves = closes
    .filter((c) => c.reserved > 0n && c.releaseOn && c.releaseOn >= start)
    .map((c) => ({ releaseOn: c.releaseOn!, amountVnd: vnd(c.reserved, c.account.currency as Currency) }));

  // Doanh thu theo kênh: trung bình tháng của 90 ngày qua; neo chu kỳ vào lần thu gần nhất.
  const shops = await tx.shop.findMany({ select: { id: true, channel: true } });
  const shopChannel = new Map(shops.map((s) => [s.id, s.channel]));
  const channels: RevenueChannel[] = CHANNELS.map((c) => {
    const list = shopIn.filter((t) => shopChannel.get(t.shopId!) === c.code);
    const total = list.reduce((s, t) => s + t.amountVnd, 0n);
    const last = list.reduce<Date | null>((m, t) => (!m || t.date > m ? t.date : m), null);
    return { channel: c.code, monthlyVnd: total / 3n, payoutEveryDays: PAYOUT_DAYS[c.code] ?? 7, anchor: last ?? start };
  }).filter((c) => c.monthlyVnd > 0n);

  // Tỷ lệ giá vốn lịch sử = giá vốn / doanh thu 90 ngày (cần có doanh thu), mặc định 35%.
  let rev = 0n;
  let cogs = 0n;
  for (const r of cogsRev) {
    const d = r._sum.debitVnd ?? 0n;
    const c = r._sum.creditVnd ?? 0n;
    if (r.accountCode.startsWith("4")) rev += c - d;
    else cogs += d - c;
  }
  const histFf = rev > 0n ? Number(divRound(cogs * 10_000n, rev)) / 10_000 : null;

  // Cơ cấu NCC fulfillment theo giá trị hoá đơn 90 ngày; chưa có hoá đơn thì chia đều.
  const billBy = new Map(billMix.map((b) => [b.supplierId, Number(b._sum.amountVnd ?? 0n)]));
  const weighted = suppliers.some((s) => (billBy.get(s.id) ?? 0) > 0);
  const fulfill: FulfillSupplier[] = suppliers.map((s) => ({
    code: s.code,
    share: weighted ? billBy.get(s.id) ?? 0 : 1,
    prepaid: s.prepaid,
    creditDays: s.creditDays,
  }));

  // Lương: kỳ lương đã duyệt gần nhất (thực nhận + BHXH + thuế) thay cho ngân sách hạng mục LUONG/BHXH.
  const payrollCost = lastPayroll ? lastPayroll.lines.reduce((s, l) => s + l.netVnd + l.insuranceEmpVnd + l.pitVnd + l.insuranceCoVnd, 0n) : 0n;
  const recurring = categories
    .filter((c) => !(payrollCost > 0n && (c.code === "LUONG" || c.code === "BHXH")))
    .map((c) => ({ label: c.name, dueDay: c.dueDay!, amountVnd: c.budgetVnd! }));
  if (payrollCost > 0n) {
    const due = categories.find((c) => c.code === "LUONG")?.dueDay ?? SALARY_DUE_DAY;
    recurring.push({ label: `Lương (theo kỳ ${lastPayroll!.month}/${lastPayroll!.year})`, dueDay: due, amountVnd: payrollCost });
  }

  const defaults: ForecastDefaults = { revenueFactor: 1, ffRate: histFf ?? 0.35, ffRateFromHistory: histFf !== null };
  const scenario: Scenario = {
    name: p.scenario?.name ?? "Cơ sở",
    revenueFactor: p.scenario?.revenueFactor ?? defaults.revenueFactor,
    ffRate: p.scenario?.ffRate ?? defaults.ffRate,
  };

  const input: ForecastInput = {
    startDate: start,
    scenario,
    openingAvailableVnd,
    reserves,
    channels,
    suppliers: fulfill,
    bills: bills.map((b) => ({ dueDate: b.dueDate, outstandingVnd: b.amountVnd - b.paidVnd })),
    recurring,
    manualItems: items.map((i) => ({
      expectedOn: i.expectedOn,
      direction: i.direction,
      amountVnd: i.amountVnd,
      confidence: i.confidence,
      recurring: (i.recurring as "MONTHLY" | "WEEKLY" | null) ?? null,
    })),
  };
  return { input, defaults, missingRate: !rate && accounts.some((a) => a.currency !== "VND"), payrollCost };
}
