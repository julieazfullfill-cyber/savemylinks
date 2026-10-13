import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { channelLabel } from "@/lib/channels";
import { todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { HELD_REASON_LOSS, HELD_REASON_UNKNOWN } from "@/lib/kpi";
import { shopIncomeUsd } from "@/lib/kpi-service";
import { formatMoney } from "@/lib/money";
import { monthRange } from "@/lib/payroll-service";
import { Badge, Flash, PageHead } from "../ui";
import { overrideFromKpi, saveKpi, saveTier } from "./actions";

const usd = (v: number) => v.toLocaleString("vi-VN", { maximumFractionDigits: 2 }) + " $";

export default async function KpiPage({ searchParams }: { searchParams: Promise<{ thang?: string; ok?: string; error?: string }> }) {
  const me = await requireUser(["ADMIN", "QUAN_LY"]);
  const sp = await searchParams;
  const today = todayVn();
  const m = /^(\d{4})-(\d{2})$/.exec(sp.thang ?? "");
  const year = m ? +m[1] : today.getUTCFullYear();
  const month = m ? +m[2] : today.getUTCMonth() + 1;
  const thang = `${year}-${String(month).padStart(2, "0")}`;
  const [from, to] = monthRange(year, month);

  const [employees, shops, targets, results, tiers, period, income] = await Promise.all([
    prisma.employee.findMany({ where: { joinedAt: { lte: to }, OR: [{ leftAt: null }, { leftAt: { gte: from } }] }, orderBy: { code: "asc" } }),
    prisma.shop.findMany({ where: { status: { not: "CLOSED" } }, orderBy: [{ channel: "asc" }, { code: "asc" }] }),
    prisma.kpiTarget.findMany({ where: { year, month } }),
    prisma.kpiResult.findMany({ where: { year, month } }),
    prisma.bonusRule.findMany({ orderBy: { fromPct: "asc" } }),
    prisma.payrollPeriod.findUnique({ where: { year_month: { year, month } } }),
    prisma.$transaction((tx) => shopIncomeUsd(tx, year, month)),
  ]);
  const tBy = new Map(targets.map((t) => [t.employeeId, t]));
  const rBy = new Map(results.map((r) => [r.employeeId, r]));
  // Chi phí chung đã nhập lần trước ≈ tổng overhead đã phân bổ.
  const lastOverhead = results.reduce((a, r) => a + Number(r.overheadUsd), 0);
  const suggestCash = (shopIds: string[]) => shopIds.reduce((a, id) => a + (income.byShop.get(id) ?? 0), 0);

  const profit = period?.companyProfitVnd ?? null;
  const gate = period?.bonusOverrideBy
    ? { tone: "good" as const, text: "Đã phê duyệt vượt cấp — thưởng được chi" }
    : profit === null
      ? { tone: "crit" as const, text: HELD_REASON_UNKNOWN }
      : profit < 0n
        ? { tone: "crit" as const, text: HELD_REASON_LOSS }
        : { tone: "good" as const, text: "Công ty có lãi — thưởng được chi" };
  const totalBonus = results.reduce((a, r) => a + r.bonusVnd, 0n);
  const editablePeriod = !period || period.status === "DRAFT" || period.status === "CALCULATED";
  const ids = employees.map((e) => e.id);

  return (
    <div className="max-w-[1400px]">
      <PageHead no={15} title={`KPI & thưởng tháng ${month}/${year}`}>
        <form method="get" className="flex items-end gap-2">
          <input className="input" name="thang" type="month" defaultValue={thang} aria-label="Tháng" />
          <button className="btn" type="submit">Xem</button>
        </form>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <p className="mt-2 max-w-4xl text-sm text-ink-2">
        Lợi nhuận KPI = <strong>tiền thực về</strong> − giá vốn fulfillment − <strong>chi phí chung phân bổ</strong> (theo tỷ trọng tiền về). Thưởng tính trên phần
        vượt target theo bậc bên dưới, quy VND theo tỷ giá cuối tháng{income.rate ? ` (${Number(income.rate).toLocaleString("vi-VN")})` : " — chưa có tỷ giá"}.
      </p>

      {/* Cổng chặn */}
      <div className={`mt-4 rounded-lg border p-4 text-sm ${gate.tone === "crit" ? "border-crit/40 bg-red-50" : "border-hair bg-surface"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">{gate.tone === "crit" ? "⛔" : "✓"} Cổng chặn thưởng: {gate.text}</div>
            <div className="text-ink-2">
              Tổng thưởng tính được {formatMoney(totalBonus)} ·{" "}
              {period ? <>Kỳ lương: <Link className="text-accent hover:underline" href={`/ky-luong/${period.id}`}>tháng {month}/{year} ({period.status})</Link>, lợi nhuận {profit === null ? "chưa nhập" : formatMoney(profit)}</> : "chưa tạo kỳ lương tháng này"}
            </div>
          </div>
          {me.role === "ADMIN" && period && editablePeriod && (profit === null || profit < 0n || period.bonusOverrideBy) && totalBonus > 0n && (
            <form action={overrideFromKpi.bind(null, thang, period.id, !!period.bonusOverrideBy)}>
              <button className={period.bonusOverrideBy ? "btn" : "btn-primary"} type="submit">{period.bonusOverrideBy ? "Thu hồi phê duyệt" : "Phê duyệt vượt cấp chi thưởng"}</button>
            </form>
          )}
        </div>
      </div>

      <form action={saveKpi.bind(null, year, month, ids)} className="card mt-4 overflow-x-auto">
        <div className="flex flex-wrap items-end gap-3 p-4">
          <div>
            <label className="label" htmlFor="overhead">Chi phí chung tháng (USD)</label>
            <input className="input w-40" id="overhead" name="overhead" inputMode="decimal" defaultValue={lastOverhead ? String(lastOverhead) : ""} placeholder="5000" />
          </div>
          <p className="max-w-xl text-xs text-muted">Chi phí cố định + lương bộ phận hỗ trợ + phí sàn cố định. Ô “Tiền về” để trống thì lấy gợi ý từ Sổ quỹ theo shop đã chọn.</p>
        </div>
        <table className="tbl text-xs">
          <thead>
            <tr>
              <th>Nhân sự</th><th>Shop phụ trách</th><th>Target (USD)</th><th>Tiền về (USD)</th><th>Giá vốn FF (USD)</th>
              <th className="text-right">CP chung</th><th className="text-right">Lợi nhuận</th><th className="text-right">% đạt</th><th className="text-right">Thưởng</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => {
              const t = tBy.get(e.id);
              const r = rBy.get(e.id);
              const shopIds = t?.shopIds ?? [];
              const sug = suggestCash(shopIds);
              const pct = r ? Number(r.achievedPct) * 100 : null;
              return (
                <tr key={e.id}>
                  <td className="whitespace-nowrap"><span className="font-mono text-muted">{e.code}</span> {e.fullName}</td>
                  <td>
                    <select className="input h-20 w-44" name={`shops_${e.id}`} multiple defaultValue={shopIds} aria-label={`Shop của ${e.code}`}>
                      {shops.map((s) => <option key={s.id} value={s.id}>{channelLabel(s.channel)} · {s.code}</option>)}
                    </select>
                  </td>
                  <td><input className="input w-24" name={`target_${e.id}`} inputMode="decimal" defaultValue={t ? String(Number(t.targetUsd)) : ""} aria-label={`Target ${e.code}`} /></td>
                  <td>
                    <input className="input w-28" name={`cash_${e.id}`} inputMode="decimal" defaultValue={r ? String(Number(r.cashReceivedUsd)) : sug ? String(sug) : ""} aria-label={`Tiền về ${e.code}`} />
                    {shopIds.length > 0 && <div className="mt-0.5 text-[10px] text-muted">Sổ quỹ: {usd(sug)}</div>}
                  </td>
                  <td><input className="input w-24" name={`ff_${e.id}`} inputMode="decimal" defaultValue={r ? String(Number(r.ffCostUsd)) : ""} aria-label={`Giá vốn ${e.code}`} /></td>
                  <td className="text-right tabular-nums">{r ? usd(Number(r.overheadUsd)) : "—"}</td>
                  <td className={`text-right tabular-nums ${r && Number(r.profitUsd) < 0 ? "text-crit" : ""}`}>{r ? usd(Number(r.profitUsd)) : "—"}</td>
                  <td className="text-right tabular-nums">{pct === null ? "—" : `${pct.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`}</td>
                  <td className="text-right font-semibold tabular-nums">{r?.bonusVnd ? formatMoney(r.bonusVnd) : "—"}</td>
                </tr>
              );
            })}
            {!employees.length && <tr><td colSpan={9} className="py-6 text-center text-muted">Chưa có nhân sự trong tháng.</td></tr>}
          </tbody>
        </table>
        {employees.length > 0 && editablePeriod && (
          <div className="p-4"><button className="btn-primary" type="submit">Tính KPI & thưởng</button></div>
        )}
        {!editablePeriod && <p className="p-4 text-sm text-crit">Kỳ lương tháng này đã {period!.status} — KPI đã khoá.</p>}
      </form>

      <section className="mt-6 max-w-3xl">
        <h2 className="font-bold">Bậc thưởng</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl text-sm">
            <thead><tr><th>Bậc</th><th>Từ % đạt</th><th>Đến %</th><th>% trên phần vượt</th><th>Trần (đ)</th><th /></tr></thead>
            <tbody>
              {tiers.map((b) => (
                <tr key={b.id}>
                  <td>{b.name} {!b.active && <Badge>ngưng</Badge>}</td>
                  {me.role === "ADMIN" ? (
                    <td colSpan={5}>
                      <form action={saveTier.bind(null, thang, b.id)} className="flex flex-wrap gap-2">
                        <input className="input w-20" name="fromPct" defaultValue={Number(b.fromPct)} aria-label="Từ %" />
                        <input className="input w-20" name="toPct" defaultValue={b.toPct === null ? "" : Number(b.toPct)} placeholder="∞" aria-label="Đến %" />
                        <input className="input w-20" name="ratePct" defaultValue={Number(b.ratePct)} aria-label="% thưởng" />
                        <input className="input w-32" name="capVnd" defaultValue={b.capVnd?.toString() ?? ""} placeholder="không trần" aria-label="Trần" />
                        <button className="btn" type="submit">Lưu</button>
                      </form>
                    </td>
                  ) : (
                    <>
                      <td>{Number(b.fromPct)}%</td><td>{b.toPct === null ? "—" : `${Number(b.toPct)}%`}</td><td>{Number(b.ratePct)}%</td>
                      <td>{b.capVnd ? formatMoney(b.capVnd) : "—"}</td><td />
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
