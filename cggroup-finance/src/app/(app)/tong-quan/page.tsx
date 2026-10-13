import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { addDays, fmtBizDate, startOfWeek, todayVn } from "@/lib/dates";
import { monthlySpendByCategory } from "@/lib/expenses";
import { buildForecast, firstWeekBelow } from "@/lib/forecast";
import { loadForecastInput } from "@/lib/forecast-data";
import { prisma } from "@/lib/db";
import { formatMoney, toVnd, type Currency } from "@/lib/money";
import { balanceSeries, bookBalance, buildAlerts, compactVnd, flows, type LedgerTxn, type Severity } from "@/lib/overview";
import { PageHead } from "../ui";
import { BalanceChart } from "./balance-chart";

const SEV: Record<Severity, { icon: string; label: string; cls: string }> = {
  crit: { icon: "⛔", label: "Nghiêm trọng", cls: "border-crit/40 bg-red-50" },
  warn: { icon: "⚠", label: "Cần xem", cls: "border-amber-300 bg-amber-50" },
  info: { icon: "ℹ", label: "Gợi ý", cls: "border-hair bg-page" },
};

export default async function OverviewPage() {
  await requireUser(["ADMIN", "QUAN_LY"]);
  const today = todayVn();
  const from90 = addDays(today, -89);
  const from30 = addDays(today, -29);

  const [accounts, txns, rates, closes, overdue] = await Promise.all([
    prisma.cashAccount.findMany({
      where: { active: true },
      include: { provider: true },
      orderBy: [{ provider: { name: "asc" } }, { code: "asc" }],
    }),
    prisma.cashTxn.findMany({
      where: { voidedAt: null },
      select: { accountId: true, date: true, direction: true, amount: true, currency: true, amountVnd: true, journal: { select: { source: true } } },
    }),
    prisma.fxRate.findMany({ where: { base: "USD", quote: "VND" }, orderBy: { date: "asc" } }),
    // lần chốt số dư gần nhất của mỗi tài khoản (màn 5)
    prisma.accountBalance.findMany({ distinct: ["accountId"], orderBy: [{ accountId: "asc" }, { date: "desc" }] }),
    prisma.supplierBill.findMany({ where: { dueDate: { lt: today }, status: { not: "PAID" } }, include: { supplier: true } }),
  ]);

  const ledger: LedgerTxn[] = txns.map((t) => ({ ...t, currency: t.currency as Currency }));
  const latestRate = rates.at(-1) ?? null;
  const closeBy = new Map(closes.map((c) => [c.accountId, c]));

  // Giá trị VND hiện tại: VND giữ nguyên, USD × tỷ giá mới nhất.
  const nowVnd = (amount: bigint, cur: Currency) => (cur === "VND" ? amount : latestRate ? toVnd(amount, cur, latestRate.rate) : null);

  const rows = accounts.map((a) => {
    const cur = a.currency as Currency;
    const book = bookBalance(ledger, a.id);
    const close = closeBy.get(a.id);
    const reserved = close?.reserved ?? 0n;
    return { a, cur, book, bookVnd: nowVnd(book, cur), close, reserved, reservedVnd: nowVnd(reserved, cur) };
  });
  const availableVnd = rows.reduce((s, r) => s + (r.bookVnd ?? 0n), 0n);
  const reservedVnd = rows.reduce((s, r) => s + (r.reservedVnd ?? 0n), 0n);
  const unvalued = rows.filter((r) => r.bookVnd === null && r.book !== 0n);

  const series = balanceSeries(
    ledger,
    rates.map((r) => ({ date: r.date, rate: r.rate.toString() })),
    from90,
    today,
  );
  const f30 = flows(
    txns.map((t) => ({ ...t, opening: t.journal?.source === "OPENING" })),
    from30,
    today,
  );

  // Dự báo theo kịch bản & ngưỡng của lần lưu gần nhất ở màn 6 (chưa lưu → không có ngưỡng).
  const snap = await prisma.forecastSnapshot.findFirst({ orderBy: { createdAt: "desc" } });
  const sc = (snap?.scenario ?? null) as { revenueFactor?: number; ffRate?: number; floorVnd?: string } | null;
  let forecastBreach: { week: number; from: Date; closingVnd: bigint; floorVnd: bigint } | null = null;
  if (sc?.floorVnd && BigInt(sc.floorVnd) > 0n) {
    const floorVnd = BigInt(sc.floorVnd);
    const { input } = await prisma.$transaction((tx) =>
      loadForecastInput(tx, { startDate: startOfWeek(today), scenario: { revenueFactor: sc.revenueFactor, ffRate: sc.ffRate } }),
    );
    const b = firstWeekBelow(buildForecast(input), floorVnd);
    if (b) forecastBreach = { week: b.week, from: b.from, closingVnd: b.closing, floorVnd };
  }

  // Chi vượt ngân sách tháng này.
  const [budgetCats, spend] = await Promise.all([
    prisma.expenseCategory.findMany({ where: { active: true, budgetVnd: { not: null } } }),
    prisma.$transaction((tx) => monthlySpendByCategory(tx, today.getUTCFullYear(), today.getUTCMonth() + 1)),
  ]);
  const overBudget = budgetCats
    .filter((c) => (spend.get(c.id) ?? 0n) > c.budgetVnd!)
    .map((c) => ({ name: c.name, usedVnd: spend.get(c.id)!, budgetVnd: c.budgetVnd! }));

  const alerts = buildAlerts({
    forecastBreach,
    overBudget,
    today,
    accounts: rows.map((r) => ({
      id: r.a.id,
      code: r.a.code,
      label: r.a.email ?? r.a.name,
      currency: r.cur,
      book: r.book,
      txnCount: txns.filter((t) => t.accountId === r.a.id).length,
      hasOpening: txns.some((t) => t.accountId === r.a.id && t.journal?.source === "OPENING"),
      lastClose: r.close ? { date: r.close.date, available: r.close.available, bookAtDate: bookBalance(ledger, r.a.id, r.close.date) } : null,
    })),
    latestUsdRateDate: latestRate?.date ?? null,
    overdueBills: overdue.map((b) => ({ supplier: b.supplier.name, dueDate: b.dueDate, outstandingVnd: b.amountVnd - b.paidVnd })),
  });

  const providers = [...new Map(rows.map((r) => [r.a.providerId, r.a.provider])).values()];
  const weekly = series.filter((_, i) => (series.length - 1 - i) % 7 === 0);

  return (
    <div className="max-w-7xl">
      <PageHead no={1} title="Tổng quan tiền">
        <span className="text-sm text-muted">
          Ngày {fmtBizDate(today)} · tỷ giá USD{" "}
          {latestRate ? `${Number(latestRate.rate).toLocaleString("vi-VN")} (${fmtBizDate(latestRate.date)})` : "chưa có"}
        </span>
      </PageHead>

      {/* Số chính + thu chi 30 ngày */}
      <div className="mt-5 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="card p-5">
          <div className="text-sm text-ink-2">Tổng tiền khả dụng, quy VND</div>
          <div className="mt-1 break-words text-3xl font-bold tracking-tight sm:text-5xl">{formatMoney(availableVnd)}</div>
          <div className="mt-2 text-sm text-ink-2">
            Bị giam trên sàn: <strong>{formatMoney(reservedVnd)}</strong> — không tính vào số khả dụng
          </div>
          {unvalued.length > 0 && (
            <div className="mt-1 text-sm text-crit">⚠ Chưa có tỷ giá: {unvalued.length} tài khoản USD chưa được tính.</div>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Thu 30 ngày", v: f30.inflow },
            { label: "Chi 30 ngày", v: f30.outflow },
            { label: "Chênh lệch", v: f30.net },
          ].map((s) => (
            <div key={s.label} className="card min-w-0 p-3 sm:p-4">
              <div className="text-xs text-ink-2">{s.label}</div>
              <div className="mt-1 text-lg font-semibold sm:text-xl">{compactVnd(Number(s.v))}</div>
              {s.label === "Chênh lệch" && (
                <div className={`text-xs ${s.v < 0n ? "text-crit" : "text-good"}`}>{s.v < 0n ? "▼ chi nhiều hơn thu" : "▲ thu nhiều hơn chi"}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Ba cảnh báo nổi bật */}
      <section className="mt-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-bold">Cảnh báo</h2>
          {alerts.length > 3 && <span className="text-xs text-muted">và {alerts.length - 3} cảnh báo khác</span>}
        </div>
        {alerts.length === 0 ? (
          <p className="card mt-2 p-4 text-sm text-good">✓ Không có gì bất thường.</p>
        ) : (
          <div className="mt-2 grid gap-3 md:grid-cols-3">
            {alerts.slice(0, 3).map((al, i) => (
              <Link key={i} href={al.href} className={`block rounded-lg border p-4 hover:shadow-sm ${SEV[al.severity].cls}`}>
                <div className="text-xs font-semibold text-ink-2">
                  <span aria-hidden>{SEV[al.severity].icon}</span> {SEV[al.severity].label}
                </div>
                <div className="mt-1 font-semibold">{al.title}</div>
                <p className="mt-1 text-sm text-ink-2">{al.detail}</p>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Biểu đồ 90 ngày */}
      <section className="card mt-5 p-5">
        <h2 className="font-bold">Số dư 90 ngày qua</h2>
        <p className="text-sm text-muted">Tổng mọi tài khoản cuối mỗi ngày, quy VND theo tỷ giá của ngày đó. Rê chuột hoặc dùng ← → để xem từng ngày.</p>
        <div className="mt-3">
          <BalanceChart points={series.map((p) => ({ date: p.date, vnd: Number(p.vnd), missingRate: p.missingRate }))} />
        </div>
        {series.some((p) => p.missingRate) && (
          <p className="mt-1 text-xs text-crit">⚠ Có ngày đang giữ USD nhưng chưa có tỷ giá — phần USD của những ngày đó chưa được tính.</p>
        )}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-accent">Xem bảng số liệu (theo tuần)</summary>
          <table className="tbl mt-2 max-w-md">
            <thead><tr><th>Ngày</th><th className="text-right">Số dư quy VND</th></tr></thead>
            <tbody>
              {weekly.map((p) => (
                <tr key={p.date}>
                  <td className="tabular-nums">{p.date.split("-").reverse().join("/")}</td>
                  <td className="text-right tabular-nums">{formatMoney(p.vnd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      {/* Thẻ số dư theo nhóm → tài khoản */}
      <section className="mt-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-bold">Số dư từng tài khoản</h2>
          <Link className="text-xs text-accent hover:underline" href="/so-quy">Mở Sổ quỹ →</Link>
        </div>
        <div className="mt-2 space-y-3">
          {providers.map((p) => {
            const list = rows.filter((r) => r.a.providerId === p.id);
            const sum = list.reduce((s, r) => s + (r.bookVnd ?? 0n), 0n);
            return (
              <div key={p.id} className="card p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-sm">≈ {formatMoney(sum)}</span>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {list.map((r) => (
                    <Link key={r.a.id} href={`/so-quy?acc=${r.a.id}`} className="block rounded-md border border-hair px-3 py-2 hover:border-accent">
                      <div className="truncate text-xs text-muted" title={r.a.email ?? r.a.name}>{r.a.code} · {r.a.email ?? r.a.name}</div>
                      <div className={`font-bold ${r.book < 0n ? "text-crit" : ""}`}>{formatMoney(r.book, r.cur)}</div>
                      {r.cur !== "VND" && <div className="text-xs text-muted">≈ {r.bookVnd === null ? "chưa có tỷ giá" : formatMoney(r.bookVnd)}</div>}
                      {r.reserved > 0n && (
                        <div className="mt-1 text-xs text-ink-2">
                          Bị giam {formatMoney(r.reserved, r.cur)}
                          {r.close?.releaseOn && <> · về {fmtBizDate(r.close.releaseOn)}</>}
                        </div>
                      )}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-muted">
          Khả dụng = số dư sổ quỹ. Phần bị giam lấy từ lần chốt số dư gần nhất (màn 5 Chốt số dư).
        </p>
      </section>
    </div>
  );
}
