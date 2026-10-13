import Link from "next/link";
import { BASIS_VI, type Basis } from "@/lib/allocation";
import { previewAllocation } from "@/lib/allocation-service";
import { requireUser } from "@/lib/auth";
import { bizDateStr, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Badge, Flash, PageHead } from "../ui";
import { runAction, saveRuleAction, undoAction } from "./actions";

type SP = { thang?: string; sua?: string; ok?: string; error?: string };
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Màn 26 — quy tắc phân bổ chi phí chung, xem trước bảng chia, chạy và sinh bút toán. */
export default async function AllocationPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireUser(["ADMIN", "KE_TOAN", "QUAN_LY"]);
  const sp = await searchParams;
  const canWrite = me.role !== "QUAN_LY";
  const today = todayVn();
  // mặc định tháng trước — phân bổ chạy khi đã đủ chi phí tháng
  const def = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const thang = /^\d{4}-\d{2}$/.test(sp.thang ?? "") ? sp.thang! : bizDateStr(def).slice(0, 7);
  const [y, m] = thang.split("-").map(Number);

  const [rules, accounts, runs, closing] = await Promise.all([
    prisma.allocationRule.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    prisma.account.findMany({ where: { type: { in: ["EXPENSE", "COGS"] } }, orderBy: { code: "asc" } }),
    prisma.allocationRun.findMany({ orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }], take: 30, include: { rule: true } }),
    prisma.periodClosing.findUnique({ where: { year_month: { year: y, month: m } } }),
  ]);
  const accName = new Map(accounts.map((a) => [a.code, a.name]));
  const closed = closing?.status === "CLOSED";
  const editing = sp.sua === "moi" ? null : rules.find((r) => r.id === sp.sua);
  const cards = await Promise.all(
    rules.map(async (r) => {
      const run = runs.find((x) => x.ruleId === r.id && x.year === y && x.month === m);
      const pv = r.active && !run ? await previewAllocation(prisma, { ruleId: r.id, year: y, month: m }) : null;
      return { r, run, pv };
    }),
  );

  return (
    <div className="max-w-7xl">
      <PageHead no={26} title="Phân bổ chi phí chung">
        <form method="get" className="flex items-end gap-2">
          <div><label className="label" htmlFor="thang">Tháng</label><input className="input" id="thang" name="thang" type="month" defaultValue={thang} /></div>
          <button className="btn" type="submit">Xem</button>
        </form>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <p className="mt-3 max-w-3xl text-sm text-ink-2">
        Chi phí không gắn shop (văn phòng, VPS, lương bộ phận hỗ trợ…) được chia về từng shop. Bút toán: Có TK nguồn (không shop) / Nợ cùng TK gắn shop —
        tổng P&L công ty không đổi, nhưng P&L theo shop / team (màn 7) nhận đủ chi phí. Chia bằng phương pháp dư lớn nhất nên khớp tới từng đồng.
      </p>
      {closed && <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm">Kỳ {m}/{y} đã đóng sổ — không chạy phân bổ được nữa.</p>}

      <div className="mt-4 space-y-4">
        {cards.map(({ r, run, pv }) => {
          return (
            <section key={r.id} className="card p-5">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-bold">{r.name}</h2>
                {!r.active && <Badge>ngưng dùng</Badge>}
                <span className="text-sm text-ink-2">{BASIS_VI[r.basis as Basis]}</span>
                <span className="text-xs text-muted">TK {r.sourceAccounts.map((c) => `${c} ${accName.get(c) ?? ""}`).join(", ")}</span>
                {canWrite && <Link className="ml-auto text-sm text-accent hover:underline" href={`/phan-bo?thang=${thang}&sua=${r.id}`}>Sửa</Link>}
              </div>
              {run ? (
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                  <Badge tone="good">Đã chạy {m}/{y}</Badge>
                  <span>Rổ {formatMoney(run.poolVnd)}</span>
                  <Link className="text-accent hover:underline" href={`/so-cai?thang=${thang}&nguon=ALLOCATION`}>Xem bút toán</Link>
                  <Link className="text-accent hover:underline" href={`/pnl?thang=${thang}&chieu=shop`}>P&L theo shop</Link>
                  {canWrite && !closed && (
                    <form action={undoAction.bind(null, thang, run.id)}><button className="btn" type="submit">Huỷ lần chạy</button></form>
                  )}
                </div>
              ) : pv ? (
                <div className="mt-3">
                  {pv.poolVnd === 0n ? (
                    <p className="text-sm text-muted">Tháng {m}/{y} chưa có chi phí chưa gắn shop trên các TK này.</p>
                  ) : (
                    <>
                      <p className="text-sm">
                        Rổ tháng {m}/{y}: <strong>{formatMoney(pv.poolVnd)}</strong>{" "}
                        <span className="text-ink-2">({pv.pools.map((p) => `${p.accountCode}: ${formatMoney(p.poolVnd)}`).join(" · ")})</span>
                      </p>
                      <div className="mt-2 overflow-x-auto">
                        <table className="tbl text-sm">
                          <thead><tr><th>Shop</th><th className="text-right">Tỷ trọng</th><th className="text-right">Nhận phân bổ</th></tr></thead>
                          <tbody>
                            {pv.byShop.map((s) => (
                              <tr key={s.targetId}><td>{s.name}</td><td className="text-right tabular-nums">{pct(s.sharePct)}</td><td className="text-right tabular-nums">{formatMoney(s.amountVnd)}</td></tr>
                            ))}
                            {!pv.byShop.length && (
                              <tr><td colSpan={3} className="py-3 text-center text-crit">Không shop nào có trọng số &gt; 0 ({r.basis === "REVENUE" ? "chưa có doanh thu trong tháng" : "chưa gán người phụ trách ở màn 16"}).</td></tr>
                            )}
                            <tr className="font-semibold"><td>Tổng</td><td /><td className="text-right tabular-nums">{formatMoney(pv.byShop.reduce((a, s) => a + s.amountVnd, 0n))}</td></tr>
                          </tbody>
                        </table>
                      </div>
                      {canWrite && !closed && pv.byShop.length > 0 && (
                        <form action={runAction.bind(null, thang, r.id)} className="mt-3"><button className="btn btn-primary" type="submit">Chạy phân bổ {m}/{y}</button></form>
                      )}
                    </>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
        {!rules.length && <p className="card p-6 text-center text-sm text-muted">Chưa có quy tắc phân bổ nào.</p>}
      </div>

      {canWrite && (
        <section className="card mt-6 p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold">{editing ? `Sửa quy tắc: ${editing.name}` : "Thêm quy tắc"}</h2>
            {editing && <Link className="text-sm text-accent hover:underline" href={`/phan-bo?thang=${thang}`}>Thêm mới thay vì sửa</Link>}
          </div>
          <form key={editing?.id ?? "moi"} action={saveRuleAction.bind(null, thang, editing?.id ?? null)} className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_260px_auto]">
              <div><label className="label" htmlFor="name">Tên *</label><input className="input" id="name" name="name" required defaultValue={editing?.name ?? ""} placeholder="VD: Chi phí văn phòng + VPS" /></div>
              <div>
                <label className="label" htmlFor="basis">Cách chia</label>
                <select className="input" id="basis" name="basis" defaultValue={editing?.basis ?? "REVENUE"}>
                  {Object.entries(BASIS_VI).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name="active" defaultChecked={editing?.active ?? true} /> Đang dùng</label>
            </div>
            <fieldset>
              <legend className="label">Tài khoản trong rổ *</legend>
              <div className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {accounts.map((a) => (
                  <label key={a.code} className="flex items-center gap-2">
                    <input type="checkbox" name="acc" value={a.code} defaultChecked={editing?.sourceAccounts.includes(a.code)} />
                    <span className="font-mono text-xs">{a.code}</span> {a.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <button className="btn btn-primary" type="submit">Lưu quy tắc</button>
          </form>
          <p className="mt-2 text-xs text-muted">
            Theo số người: số nhân viên của phòng ban người phụ trách shop, chia đều cho các shop của phòng đó. Chỉ chi phí CHƯA gắn shop mới vào rổ — chi phí đã gắn shop
            (phí sàn của shop, quảng cáo của shop) giữ nguyên.
          </p>
        </section>
      )}

      <section className="mt-6">
        <h2 className="font-bold">Lịch sử chạy</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl text-sm">
            <thead><tr><th>Kỳ</th><th>Quy tắc</th><th className="text-right">Rổ</th><th>Lúc chạy</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><Link className="text-accent hover:underline" href={`/phan-bo?thang=${r.year}-${String(r.month).padStart(2, "0")}`}>{r.month}/{r.year}</Link></td>
                  <td>{r.rule.name}</td>
                  <td className="text-right tabular-nums">{formatMoney(r.poolVnd)}</td>
                  <td className="text-xs text-muted">{r.createdAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</td>
                </tr>
              ))}
              {!runs.length && <tr><td colSpan={4} className="py-4 text-center text-muted">Chưa chạy lần nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
