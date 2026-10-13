// Màn hình 15 — KPI & thưởng trên DB.
// profit = tiền VỀ THẬT (thu từ shop người đó phụ trách, Sổ quỹ) − giá vốn FF − chi phí chung phân bổ.
import { assertMonthOpen } from "./attendance";
import { audit } from "./audit";
import { dayOfMonth } from "./dates";
import type { Tx } from "./db";
import { allocateOverhead, computeBonus, computeKpi, type BonusTier } from "./kpi";
import { lookupFxRate } from "./ledger";
import { divRound, rateToScaled } from "./money";

/** Tiền thu từ từng shop trong tháng, quy USD (giao dịch USD lấy nguyên tệ; VND chia tỷ giá cuối tháng). */
export async function shopIncomeUsd(tx: Tx, year: number, month: number): Promise<{ byShop: Map<string, number>; rate: string | null }> {
  const from = dayOfMonth(year, month - 1, 1);
  const to = dayOfMonth(year, month - 1, 31);
  const rate = await lookupFxRate(tx, to, "USD").then((r) => r.rate).catch(() => null);
  const txns = await tx.cashTxn.findMany({
    where: { voidedAt: null, direction: "IN", shopId: { not: null }, categoryId: null, date: { gte: from, lte: to }, journal: { source: "CASH_TXN" } },
    select: { shopId: true, amount: true, currency: true, amountVnd: true },
  });
  const byShop = new Map<string, number>();
  for (const t of txns) {
    let cents: bigint | null = null;
    if (t.currency === "USD") cents = t.amount;
    else if (rate) cents = divRound(t.amountVnd * 100n * 1_000_000n, rateToScaled(rate));
    if (cents === null) continue;
    byShop.set(t.shopId!, (byShop.get(t.shopId!) ?? 0) + Number(cents) / 100);
  }
  return { byShop, rate };
}

export type KpiRowInput = { employeeId: string; targetUsd: number; shopIds: string[]; cashReceivedUsd: number; ffCostUsd: number };

export async function saveKpiMonth(tx: Tx, p: { year: number; month: number; overheadTotalUsd: number; rows: KpiRowInput[]; actorId: string }) {
  await assertMonthOpen(tx, p.year, p.month);
  for (const r of p.rows) {
    if (r.targetUsd < 0 || r.cashReceivedUsd < 0 || r.ffCostUsd < 0) throw new Error("Số KPI không được âm");
  }
  if (p.overheadTotalUsd < 0) throw new Error("Chi phí chung không được âm");

  const tiers: BonusTier[] = (await tx.bonusRule.findMany({ where: { active: true }, orderBy: { fromPct: "asc" } })).map((b) => ({
    fromPct: Number(b.fromPct),
    toPct: b.toPct === null ? null : Number(b.toPct),
    ratePct: Number(b.ratePct),
    capVnd: b.capVnd === null ? null : Number(b.capVnd),
  }));
  const monthEnd = dayOfMonth(p.year, p.month - 1, 31);
  const rate = (await lookupFxRate(tx, monthEnd, "USD")).rate;

  // Chi phí chung phân bổ theo tỷ trọng tiền về của công ty trong tháng (mọi shop).
  const { byShop } = await shopIncomeUsd(tx, p.year, p.month);
  const companyRevenue = [...byShop.values()].reduce((a, v) => a + v, 0) || p.rows.reduce((a, r) => a + r.cashReceivedUsd, 0);

  const results = [];
  for (const r of p.rows) {
    if (r.targetUsd === 0 && r.cashReceivedUsd === 0 && r.ffCostUsd === 0 && !r.shopIds.length) continue;
    await tx.kpiTarget.upsert({
      where: { employeeId_year_month: { employeeId: r.employeeId, year: p.year, month: p.month } },
      create: { employeeId: r.employeeId, year: p.year, month: p.month, targetUsd: r.targetUsd, shopIds: r.shopIds },
      update: { targetUsd: r.targetUsd, shopIds: r.shopIds },
    });
    const overheadUsd = allocateOverhead(r.cashReceivedUsd, companyRevenue, p.overheadTotalUsd);
    const k = computeKpi({ cashReceivedUsd: r.cashReceivedUsd, ffCostUsd: r.ffCostUsd, overheadUsd, targetUsd: r.targetUsd });
    const bonusVnd = computeBonus(k, tiers, rate);
    const data = {
      cashReceivedUsd: r.cashReceivedUsd,
      ffCostUsd: r.ffCostUsd,
      overheadUsd,
      profitUsd: k.profitUsd,
      targetUsd: k.targetUsd,
      achievedPct: Math.round(k.achievedPct * 10_000) / 10_000,
      bonusVnd,
    };
    const res = await tx.kpiResult.upsert({
      where: { employeeId_year_month: { employeeId: r.employeeId, year: p.year, month: p.month } },
      create: { employeeId: r.employeeId, year: p.year, month: p.month, ...data },
      update: data,
    });
    results.push(res);
  }
  // KPI đổi thì kỳ lương tháng đó (nếu đã tính) phải tính lại.
  await tx.payrollPeriod.updateMany({ where: { year: p.year, month: p.month, status: "CALCULATED" }, data: { status: "DRAFT" } });
  await audit(tx, { actorId: p.actorId, tableName: "KpiResult", recordId: `${p.year}-${p.month}`, action: "UPDATE", after: { rows: results.length, overheadTotalUsd: p.overheadTotalUsd, rate } });
  return { results, rate, tiers };
}
