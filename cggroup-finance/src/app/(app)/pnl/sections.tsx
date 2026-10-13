// Màn 7/25 (GĐ4): P&L một tháng theo chiều + so kỳ trước, ngân sách theo tháng.
import Link from "next/link";
import { budgetsFor } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { monthlySpendByCategory } from "@/lib/expenses";
import { formatMoney } from "@/lib/money";
import { compactVnd } from "@/lib/overview";
import { DIM_VI, pnlByDimension, UNASSIGNED, type Dim } from "@/lib/pnl-dims";
import { saveBudgets } from "./actions";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export async function DimensionSection({ thang, chieu, year }: { thang: string; chieu: Dim; year: number }) {
  const [y, m] = thang.split("-").map(Number);
  const r = await pnlByDimension(prisma, { year: y, month: m, dim: chieu });
  const cols = r.columns;
  const ROWS = [
    ["Doanh thu", (p: typeof r.total) => p.revenueVnd],
    ["Giá vốn", (p: typeof r.total) => p.cogsVnd],
    ["Lãi gộp", (p: typeof r.total) => p.grossProfitVnd],
    ["Chi phí hoạt động", (p: typeof r.total) => p.expenseVnd],
    ["Thu chi khác", (p: typeof r.total) => p.otherVnd],
    ["Lợi nhuận", (p: typeof r.total) => p.netProfitVnd],
  ] as const;
  const unassigned = cols.find((c) => c.key === UNASSIGNED);
  const delta = r.total.netProfitVnd - r.prevTotal.netProfitVnd;

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-bold">P&L tháng {m}/{y} theo {DIM_VI[chieu].toLowerCase()}</h2>
          <p className="text-sm text-ink-2">
            So với {r.prev.month}/{r.prev.year}: lợi nhuận {formatMoney(r.prevTotal.netProfitVnd)} →{" "}
            <strong className={r.total.netProfitVnd < 0n ? "text-crit" : ""}>{formatMoney(r.total.netProfitVnd)}</strong>{" "}
            <span className={delta < 0n ? "text-crit" : "text-good"}>({delta >= 0n ? "+" : ""}{compactVnd(Number(delta))})</span>
          </p>
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="nam" value={year} />
          <div><label className="label" htmlFor="thang">Tháng</label><input className="input" id="thang" name="thang" type="month" defaultValue={thang} /></div>
          <div>
            <label className="label" htmlFor="chieu">Theo</label>
            <select className="input" id="chieu" name="chieu" defaultValue={chieu}>
              {Object.entries(DIM_VI).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <button className="btn" type="submit">Xem</button>
          <a className="btn" href={`/pnl/xuat?thang=${thang}&chieu=${chieu}`}>Xuất Excel</a>
        </form>
      </div>
      <div className="card mt-2 overflow-x-auto">
        <table className="tbl text-sm">
          <thead>
            <tr>
              <th className="min-w-[160px]">Khoản mục</th>
              {cols.map((c) => <th key={c.key} className="text-right">{c.label}</th>)}
              <th className="text-right">Tổng</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([label, f]) => (
              <tr key={label} className={label === "Lãi gộp" || label === "Lợi nhuận" ? "bg-page font-semibold" : ""}>
                <td>{label}</td>
                {cols.map((c) => <td key={c.key} className={`text-right tabular-nums ${label === "Lợi nhuận" && f(c.pnl) < 0n ? "text-crit" : ""}`}>{compactVnd(Number(f(c.pnl)))}</td>)}
                <td className="text-right tabular-nums">{compactVnd(Number(f(r.total)))}</td>
              </tr>
            ))}
            <tr className="text-ink-2">
              <td>Biên lợi nhuận</td>
              {cols.map((c) => <td key={c.key} className="text-right tabular-nums">{c.pnl.revenueVnd > 0n ? pct(c.pnl.netMarginPct) : "—"}</td>)}
              <td className="text-right tabular-nums">{r.total.revenueVnd > 0n ? pct(r.total.netMarginPct) : "—"}</td>
            </tr>
            <tr className="text-ink-2">
              <td>Lợi nhuận {r.prev.month}/{r.prev.year}</td>
              {cols.map((c) => <td key={c.key} className="text-right tabular-nums">{compactVnd(Number(c.prevNet))}</td>)}
              <td className="text-right tabular-nums">{compactVnd(Number(r.prevTotal.netProfitVnd))}</td>
            </tr>
            {!cols.length && <tr><td colSpan={2} className="py-4 text-center text-muted">Chưa có bút toán trong tháng.</td></tr>}
          </tbody>
        </table>
      </div>
      {unassigned && chieu !== "entity" && (unassigned.pnl.expenseVnd > 0n || unassigned.pnl.cogsVnd > 0n) && (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm">
          ⚠ Cột “Chưa gắn” còn {unassigned.pnl.cogsVnd > 0n && <>{formatMoney(unassigned.pnl.cogsVnd)} giá vốn (hoá đơn NCC không ghi theo shop)</>}
          {unassigned.pnl.cogsVnd > 0n && unassigned.pnl.expenseVnd > 0n && " và "}
          {unassigned.pnl.expenseVnd > 0n && <>{formatMoney(unassigned.pnl.expenseVnd)} chi phí chung (văn phòng, lương, công cụ…)</>} — lãi từng {chieu === "team" ? "team" : "shop"} còn
          đang ảo. <Link className="text-accent hover:underline" href={`/phan-bo?thang=${thang}`}>Chạy phân bổ</Link> (giá vốn nên chia theo giá vốn fulfillment của shop).
        </p>
      )}
      {chieu === "team" && <p className="mt-1 text-xs text-muted">Team = phòng ban của người phụ trách shop (màn 16). Shop chưa có người phụ trách nằm ở “Chưa gắn”.</p>}
    </section>
  );
}

export async function BudgetSection({ thang, canEdit }: { thang: string; canEdit: boolean }) {
  const [y, m] = thang.split("-").map(Number);
  const [budgets, spend] = await Promise.all([budgetsFor(prisma, y, m), monthlySpendByCategory(prisma, y, m)]);
  const rows = budgets.filter((b) => b.budgetVnd !== null || (spend.get(b.category.id) ?? 0n) > 0n);
  const all = canEdit ? budgets : rows;
  const totalB = rows.reduce((a, b) => a + (b.budgetVnd ?? 0n), 0n);
  const totalS = rows.reduce((a, b) => a + (spend.get(b.category.id) ?? 0n), 0n);
  return (
    <section className="mt-6">
      <h2 className="font-bold">Ngân sách tháng {m}/{y}</h2>
      <p className="text-sm text-ink-2">
        Ngân sách riêng cho tháng này; bỏ trống thì dùng ngân sách mặc định của hạng mục (màn 8). Thực chi = đề nghị chi đã duyệt + chi Sổ quỹ gắn hạng mục.
      </p>
      <form action={saveBudgets.bind(null, thang)} className="card mt-2 overflow-x-auto">
        <table className="tbl text-sm">
          <thead><tr><th>Hạng mục</th><th className="text-right">Ngân sách</th><th className="text-right">Thực chi</th><th className="text-right">Đã dùng</th></tr></thead>
          <tbody>
            {all.map((b) => {
              const s = spend.get(b.category.id) ?? 0n;
              const used = b.budgetVnd ? Number(s) / Number(b.budgetVnd) : null;
              return (
                <tr key={b.category.id}>
                  <td>{b.category.name} <span className="text-xs text-muted">· TK {b.category.accountCode}</span></td>
                  <td className="text-right">
                    {canEdit ? (
                      <input
                        className="input ml-auto w-36 text-right"
                        name={`b_${b.category.id}`}
                        inputMode="numeric"
                        aria-label={`Ngân sách ${b.category.name}`}
                        defaultValue={b.monthly ? String(b.budgetVnd) : ""}
                        placeholder={b.category.budgetVnd ? String(b.category.budgetVnd) : "—"}
                      />
                    ) : b.budgetVnd !== null ? formatMoney(b.budgetVnd) : "—"}
                  </td>
                  <td className="text-right tabular-nums">{s ? formatMoney(s) : "—"}</td>
                  <td className={`text-right tabular-nums ${used !== null && used > 1 ? "font-semibold text-crit" : ""}`}>{used === null ? "—" : pct(used)}</td>
                </tr>
              );
            })}
            <tr className="font-semibold"><td>Tổng (hạng mục có ngân sách / có chi)</td><td className="text-right tabular-nums">{formatMoney(totalB)}</td><td className="text-right tabular-nums">{formatMoney(totalS)}</td><td /></tr>
          </tbody>
        </table>
        {canEdit && <div className="p-3"><button className="btn btn-primary" type="submit">Lưu ngân sách tháng {m}/{y}</button></div>}
      </form>
    </section>
  );
}
