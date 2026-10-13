import type { AccountType } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { dayOfMonth, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { divRound, formatMoney, rateToScaled } from "@/lib/money";
import { compactVnd, rateOn } from "@/lib/overview";
import { buildPnl, type PnlMonth } from "@/lib/pnl";
import { loadLedgerRows } from "@/lib/pnl-data";
import type { Dim } from "@/lib/pnl-dims";
import { Flash, PageHead } from "../ui";
import { BudgetSection, DimensionSection } from "./sections";
import { importLegacy } from "./actions";

const LINES: { key: keyof PnlMonth; label: string; strong?: boolean; type?: AccountType }[] = [
  { key: "revenue", label: "Doanh thu", type: "REVENUE" },
  { key: "cogs", label: "Giá vốn", type: "COGS" },
  { key: "gross", label: "Lãi gộp", strong: true },
  { key: "expense", label: "Chi phí hoạt động", type: "EXPENSE" },
  { key: "other", label: "Thu chi khác (tỷ giá, bất thường)", type: "OTHER" },
  { key: "net", label: "Lợi nhuận", strong: true },
];

const mLabel = (m: string) => `T${Number(m.slice(5))}/${m.slice(2, 4)}`;

export default async function PnlPage({ searchParams }: { searchParams: Promise<{ nam?: string; thang?: string; chieu?: string; ok?: string; error?: string }> }) {
  const me = await requireUser(["ADMIN", "QUAN_LY", "KE_TOAN"]);
  const sp = await searchParams;
  const year = Number(sp.nam) || todayVn().getUTCFullYear();
  const from = dayOfMonth(year, 0, 1);
  const to = dayOfMonth(year, 11, 31);
  // GĐ4: P&L một tháng theo chiều (mặc định tháng hiện tại, theo shop) + ngân sách tháng
  const thang = /^\d{4}-\d{2}$/.test(sp.thang ?? "") ? sp.thang! : todayVn().toISOString().slice(0, 7);
  const chieu: Dim = sp.chieu === "entity" || sp.chieu === "team" ? sp.chieu : "shop";

  const [raw, legacy, rates] = await Promise.all([
    loadLedgerRows(prisma, from, to),
    prisma.legacyPnl.findMany({ where: { year }, orderBy: [{ month: "asc" }, { team: "asc" }] }),
    prisma.fxRate.findMany({ where: { base: "USD", quote: "VND" }, orderBy: { date: "asc" } }),
  ]);
  const pnl = buildPnl(raw);
  const months = pnl.months;

  // Excel cũ theo tháng (cộng các team), đặt cạnh lợi nhuận hệ thống quy USD theo tỷ giá cuối tháng.
  const legacyByMonth = new Map<string, { rev: number; exp: number; prof: number; teams: number; bad: number }>();
  for (const l of legacy) {
    const k = `${l.year}-${String(l.month).padStart(2, "0")}`;
    const v = legacyByMonth.get(k) ?? { rev: 0, exp: 0, prof: 0, teams: 0, bad: 0 };
    const rev = Number(l.revenueUsd);
    const exp = Number(l.expenseUsd);
    const prof = Number(l.profitUsd);
    v.rev += rev;
    v.exp += exp;
    v.prof += prof;
    v.teams++;
    if (Math.round((rev - exp) * 100) !== Math.round(prof * 100)) v.bad++;
    legacyByMonth.set(k, v);
  }
  const compareMonths = [...new Set([...months, ...legacyByMonth.keys()])].sort();
  const rateList = rates.map((r) => ({ date: r.date, rate: r.rate.toString() }));
  const toUsd = (vnd: bigint, m: string) => {
    const r = rateOn(rateList, dayOfMonth(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 31));
    return r ? Number(divRound(vnd * 100_000_000n, rateToScaled(r))) / 100 : null;
  };
  const usd = (v: number) => v.toLocaleString("vi-VN", { maximumFractionDigits: 0 }) + " $";

  return (
    <div className="max-w-7xl">
      <PageHead no={7} title="P&L quản trị">
        <form method="get" className="flex items-end gap-2">
          <div>
            <label className="label" htmlFor="nam">Năm</label>
            <input className="input w-24" id="nam" name="nam" type="number" defaultValue={year} min={2020} max={2100} />
          </div>
          <button className="btn" type="submit">Xem</button>
          <a className="btn" href={`/pnl/xuat?nam=${year}`}>Xuất Excel</a>
        </form>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <p className="mt-3 max-w-3xl text-sm text-ink-2">
        Màn 7 + màn 25 (GĐ4). Tính thẳng từ sổ cái theo ngày bút toán (bỏ bút toán kết chuyển khi đóng sổ): doanh thu khi tiền shop về, chi phí khi đề nghị chi được duyệt hoặc hoá đơn NCC
        được ghi nhận, lương khi kỳ lương được duyệt. Không có ô nào để gõ tay.
      </p>

      <div className="card mt-4 overflow-x-auto">
        {months.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">Chưa có bút toán doanh thu / chi phí nào trong năm {year}.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th className="min-w-[220px]">Khoản mục (VND)</th>
                {months.map((m) => <th key={m} className="text-right">{mLabel(m)}</th>)}
                <th className="text-right">Cả năm</th>
              </tr>
            </thead>
            <tbody>
              {LINES.map((line) => {
                const accs = line.type ? pnl.accounts.filter((a) => a.type === line.type) : [];
                return [
                  <tr key={line.key} className={line.strong ? "bg-page font-semibold" : ""}>
                    <td>{line.label}</td>
                    {months.map((m) => {
                      const v = pnl.byMonth.get(m)![line.key];
                      return <td key={m} className={`whitespace-nowrap text-right tabular-nums ${line.key === "net" && v < 0n ? "text-crit" : ""}`}>{compactVnd(Number(v))}</td>;
                    })}
                    <td className={`whitespace-nowrap text-right tabular-nums ${line.key === "net" && pnl.total.net < 0n ? "text-crit" : ""}`}>{compactVnd(Number(pnl.total[line.key]))}</td>
                  </tr>,
                  ...accs.map((a) => (
                    <tr key={`${line.key}-${a.code}`} className="text-ink-2">
                      <td className="pl-8 text-xs">{a.code} · {a.name}</td>
                      {months.map((m) => <td key={m} className="whitespace-nowrap text-right text-xs tabular-nums">{a.months.get(m) ? compactVnd(Number(a.months.get(m))) : "—"}</td>)}
                      <td className="whitespace-nowrap text-right text-xs tabular-nums">{compactVnd(Number([...a.months.values()].reduce((s, v) => s + v, 0n)))}</td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        )}
      </div>
      {months.length > 0 && <p className="mt-1 text-xs text-muted">Lợi nhuận cả năm chính xác: {formatMoney(pnl.total.net)}.</p>}

      <DimensionSection thang={thang} chieu={chieu} year={year} />
      <BudgetSection thang={thang} canEdit={me.role === "ADMIN" || me.role === "KE_TOAN"} />

      <section className="mt-6">
        <h2 className="font-bold">Đối chiếu với P&L Excel cũ</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Tháng</th><th className="text-right">Lợi nhuận hệ thống</th><th className="text-right">≈ USD (tỷ giá cuối tháng)</th>
                <th className="text-right">Lợi nhuận Excel (USD)</th><th className="text-right">Chênh</th><th>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {compareMonths.map((m) => {
                const sys = pnl.byMonth.get(m);
                const sysUsd = sys ? toUsd(sys.net, m) : null;
                const lg = legacyByMonth.get(m);
                return (
                  <tr key={m}>
                    <td>{mLabel(m)}</td>
                    <td className="text-right tabular-nums">{sys ? formatMoney(sys.net) : <span className="text-muted">—</span>}</td>
                    <td className="text-right tabular-nums">{sysUsd !== null ? usd(sysUsd) : <span className="text-muted">—</span>}</td>
                    <td className="text-right tabular-nums">{lg ? usd(lg.prof) : <span className="text-muted">—</span>}</td>
                    <td className="text-right tabular-nums">{lg && sysUsd !== null ? usd(sysUsd - lg.prof) : ""}</td>
                    <td className="text-xs">
                      {lg && `${lg.teams} team`}
                      {lg && lg.bad > 0 && <span className="text-crit"> · ⚠ {lg.bad} dòng profit ≠ doanh thu − chi phí</span>}
                    </td>
                  </tr>
                );
              })}
              {!compareMonths.length && <tr><td colSpan={6} className="py-6 text-center text-muted">Chưa có dữ liệu.</td></tr>}
            </tbody>
          </table>
        </div>

        {(me.role === "ADMIN" || me.role === "KE_TOAN") && (
          <form action={importLegacy} className="card mt-4 p-5">
            <h3 className="font-bold">Nạp số liệu Excel T4–T10</h3>
            <p className="mt-1 text-sm text-muted">
              Dán CSV từ script ETL: <code>team,year,month,revenueUsd,expenseUsd,profitUsd</code>. Số dùng dấu chấm thập phân.
              Nạp lại cùng team/tháng sẽ ghi đè. Dòng có profit sai công thức vẫn được nạp, kèm cảnh báo.
            </p>
            <textarea className="input mt-3 h-36 font-mono text-xs" name="csv" required placeholder={"team,year,month,revenueUsd,expenseUsd,profitUsd\nTeam 1,2026,8,52000.00,55475.00,-3475.00"} />
            <button className="btn-primary mt-3" type="submit">Nạp</button>
          </form>
        )}
      </section>
    </div>
  );
}
