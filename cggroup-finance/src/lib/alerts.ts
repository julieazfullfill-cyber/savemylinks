// GĐ4 — mọi cảnh báo của hệ thống ở một chỗ: màn 1, màn 28, dashboard và job hằng ngày dùng chung.
// syncAlertLog ghi lịch sử: cảnh báo mới bắn → mở một dòng AlertLog; hết bắn → đóng (resolvedAt).
import { addDays, fmtBizDate, startOfWeek } from "./dates";
import type { Tx } from "./db";
import { monthlySpendByCategory } from "./expenses";
import { buildForecast, firstWeekBelow } from "./forecast";
import { loadForecastInput } from "./forecast-data";
import { formatMoney, type Currency } from "./money";
import { loadOrderAlerts } from "./order-alerts-data";
import { bookBalance, buildAlerts, type Alert, type LedgerTxn, type Severity } from "./overview";
import { TAX_KINDS } from "./receivables";

const RANK: Record<Severity, number> = { crit: 0, warn: 1, info: 2 };
export const LEVEL_OF: Record<Severity, "ERROR" | "WARN" | "INFO"> = { crit: "ERROR", warn: "WARN", info: "INFO" };

/** Ngân sách tháng: dòng Budget của tháng đó, không có thì ExpenseCategory.budgetVnd. */
export async function budgetsFor(db: Tx, year: number, month: number) {
  const [cats, rows] = await Promise.all([
    db.expenseCategory.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    db.budget.findMany({ where: { year, month } }),
  ]);
  const m = new Map(rows.map((r) => [r.categoryId, r.amountVnd]));
  return cats.map((c) => ({ category: c, budgetVnd: m.get(c.id) ?? c.budgetVnd ?? null, monthly: m.has(c.id) }));
}

export async function loadAllAlerts(db: Tx, today: Date): Promise<Alert[]> {
  const [accounts, txns, latestRate, closes, overdue, taxes, ars, lastClosing] = await Promise.all([
    db.cashAccount.findMany({ where: { active: true } }),
    db.cashTxn.findMany({
      where: { voidedAt: null },
      select: { accountId: true, date: true, direction: true, amount: true, currency: true, journal: { select: { source: true } } },
    }),
    db.fxRate.findFirst({ where: { base: "USD", quote: "VND" }, orderBy: { date: "desc" } }),
    db.accountBalance.findMany({ distinct: ["accountId"], orderBy: [{ accountId: "asc" }, { date: "desc" }] }),
    db.supplierBill.findMany({ where: { dueDate: { lt: today }, status: { not: "PAID" } }, include: { supplier: true } }),
    db.taxObligation.findMany({ where: { status: { not: "PAID" }, dueDate: { lte: addDays(today, 7) } } }),
    db.arInvoice.findMany({ where: { status: { not: "PAID" }, dueDate: { lt: addDays(today, -30) } } }),
    db.periodClosing.findFirst({ where: { status: "CLOSED" }, orderBy: [{ year: "desc" }, { month: "desc" }] }),
  ]);
  const ledger: LedgerTxn[] = txns.map((t) => ({ ...t, currency: t.currency as Currency }));
  const closeBy = new Map(closes.map((c) => [c.accountId, c]));

  // Dự báo theo kịch bản & ngưỡng lần lưu gần nhất ở màn 6
  const snap = await db.forecastSnapshot.findFirst({ orderBy: { createdAt: "desc" } });
  const sc = (snap?.scenario ?? null) as { revenueFactor?: number; ffRate?: number; floorVnd?: string } | null;
  let forecastBreach: { week: number; from: Date; closingVnd: bigint; floorVnd: bigint } | null = null;
  if (sc?.floorVnd && BigInt(sc.floorVnd) > 0n) {
    const floorVnd = BigInt(sc.floorVnd);
    const { input } = await loadForecastInput(db, { startDate: startOfWeek(today), scenario: { revenueFactor: sc.revenueFactor, ffRate: sc.ffRate } });
    const b = firstWeekBelow(buildForecast(input), floorVnd);
    if (b) forecastBreach = { week: b.week, from: b.from, closingVnd: b.closing, floorVnd };
  }

  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const [budgets, spend] = await Promise.all([budgetsFor(db, y, m), monthlySpendByCategory(db, y, m)]);
  const overBudget = budgets
    .filter((b) => b.budgetVnd !== null && (spend.get(b.category.id) ?? 0n) > b.budgetVnd)
    .map((b) => ({ name: b.category.name, usedVnd: spend.get(b.category.id)!, budgetVnd: b.budgetVnd! }));

  const base = buildAlerts({
    forecastBreach,
    overBudget,
    today,
    accounts: accounts.map((a) => {
      const close = closeBy.get(a.id);
      return {
        id: a.id,
        code: a.code,
        label: a.email ?? a.name,
        currency: a.currency as Currency,
        book: bookBalance(ledger, a.id),
        txnCount: txns.filter((t) => t.accountId === a.id).length,
        hasOpening: txns.some((t) => t.accountId === a.id && t.journal?.source === "OPENING"),
        lastClose: close ? { date: close.date, available: close.available, bookAtDate: bookBalance(ledger, a.id, close.date) } : null,
      };
    }),
    latestUsdRateDate: latestRate?.date ?? null,
    overdueBills: overdue.map((b) => ({ supplier: b.supplier.name, dueDate: b.dueDate, outstandingVnd: b.amountVnd - b.paidVnd })),
  });

  // GĐ4: thuế sắp / quá hạn, phải thu quá hạn > 30 ngày, tháng trước chưa đóng sổ sau ngày 10
  const gd4: Alert[] = [];
  for (const t of taxes) {
    const late = t.dueDate < today;
    gd4.push({
      code: "TAX_DUE",
      severity: late ? "crit" : "warn",
      title: `${late ? "Quá hạn nộp" : "Sắp đến hạn nộp"}: ${TAX_KINDS[t.kind]?.label ?? t.kind} ${t.periodLabel}`,
      detail: `${formatMoney(t.amountVnd - t.paidVnd)} — hạn ${fmtBizDate(t.dueDate)}.`,
      href: "/cong-no?tab=thue",
    });
  }
  if (ars.length) {
    const sum = ars.reduce((a, r) => a + r.amountVnd - r.paidVnd, 0n);
    gd4.push({
      code: "AR_OVERDUE",
      severity: "warn",
      title: `${ars.length} khoản phải thu quá hạn hơn 30 ngày`,
      detail: `Tổng ${formatMoney(sum)}; lâu nhất ${ars.sort((a, b) => +a.dueDate - +b.dueDate)[0].counterparty}.`,
      href: "/cong-no?tab=phai-thu",
    });
  }
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const prevClosed = lastClosing && (lastClosing.year > prev.y || (lastClosing.year === prev.y && lastClosing.month >= prev.m));
  if (today.getUTCDate() > 10 && !prevClosed && txns.some((t) => t.date < new Date(Date.UTC(y, m - 1, 1)))) {
    gd4.push({
      code: "NOT_CLOSED",
      severity: "warn",
      title: `Chưa đóng sổ tháng ${prev.m}/${prev.y}`,
      detail: "Đã qua ngày 10 — chạy bộ kiểm tra và đóng sổ để khoá số liệu tháng trước.",
      href: `/dong-so?thang=${prev.y}-${String(prev.m).padStart(2, "0")}`,
    });
  }

  const orders = await loadOrderAlerts(db, today);
  return [...base, ...orders, ...gd4].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

const keyOf = (a: Alert) => `${a.code ?? a.href.split("?")[0]}|${a.title}`;

/** Ghi lịch sử cảnh báo: mở dòng cho cảnh báo mới, cập nhật nội dung, đóng dòng đã hết bắn. */
export async function syncAlertLog(db: Tx, alerts: Alert[], now = new Date()) {
  const open = await db.alertLog.findMany({ where: { resolvedAt: null } });
  const openBy = new Map(open.map((o) => [o.key, o]));
  const seen = new Set<string>();
  let opened = 0;
  for (const a of alerts) {
    const key = keyOf(a);
    if (seen.has(key)) continue;
    seen.add(key);
    const cur = openBy.get(key);
    if (cur) {
      if (cur.detail !== a.detail || cur.level !== LEVEL_OF[a.severity]) {
        await db.alertLog.update({ where: { id: cur.id }, data: { detail: a.detail, level: LEVEL_OF[a.severity] } });
      }
    } else {
      opened++;
      await db.alertLog.create({
        data: { code: a.code ?? a.href.split("?")[0], key, level: LEVEL_OF[a.severity], title: a.title, detail: a.detail, href: a.href, firedAt: now },
      });
    }
  }
  const gone = open.filter((o) => !seen.has(o.key));
  if (gone.length) await db.alertLog.updateMany({ where: { id: { in: gone.map((g) => g.id) } }, data: { resolvedAt: now } });
  return { opened, resolved: gone.length, open: seen.size };
}
