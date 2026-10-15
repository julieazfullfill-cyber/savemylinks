import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { bizDateStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { SECTION_VI, type Section } from "@/lib/monthly-report";
import { reconcile, rowErrors, unmatchedShops } from "@/lib/report-staging";
import { Badge, Flash, PageHead } from "../ui";
import { rematchAction, saveAction } from "./actions";

type SP = { nguon?: string; ok?: string; error?: string };
const usd = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const major = (amount: bigint, cur: string) => (cur === "USD" ? (Number(amount) / 100).toFixed(2) : String(amount));

/** Màn 31 — thu chi lịch sử từ file báo cáo tháng: đối chiếu với file, gắn shop / TK / hạng mục, chốt thành Sổ quỹ. */
export default async function ReportReconcilePage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireUser(["ADMIN", "KE_TOAN", "QUAN_LY"]);
  const canWrite = me.role !== "QUAN_LY";
  const sp = await searchParams;

  const [sources, counts] = await Promise.all([
    prisma.stagedSource.findMany({ orderBy: [{ team: "asc" }, { year: "asc" }, { month: "asc" }] }),
    prisma.stagedTxn.groupBy({ by: ["source", "status"], _count: true }),
  ]);
  if (!sources.length) {
    return (
      <div className="max-w-7xl">
        <PageHead no={31} title="Đối chiếu thu chi" />
        <p className="card mt-4 p-6 text-sm text-muted">
          Chưa có dữ liệu. Chạy <code>npm run import:report -- --dir &quot;G:\My Drive\CGGroup Finance Report&quot; --apply</code>.
        </p>
      </div>
    );
  }
  const cnt = (s: string, st: string) => counts.find((c) => c.source === s && c.status === st)?._count ?? 0;
  const src = sources.find((s) => s.source === sp.nguon) ?? sources[0];

  const [rows, accounts, shops, cats, sups, glAccounts] = await Promise.all([
    prisma.stagedTxn.findMany({ where: { source: src.source }, orderBy: { line: "asc" } }),
    prisma.cashAccount.findMany({ include: { provider: true }, orderBy: [{ provider: { name: "asc" } }, { code: "asc" }] }),
    prisma.shop.findMany({ orderBy: { code: "asc" } }),
    prisma.expenseCategory.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.supplier.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.account.findMany({ where: { OR: [{ type: "REVENUE" }, { type: "OTHER" }, { code: { in: ["501", "301"] } }] }, orderBy: { code: "asc" } }),
  ]);
  const totals = src.totals as Record<string, number>;
  const recon = reconcile(totals, rows);
  const rate = src.fxRate ? Number(src.fxRate) : 0;
  const draft = rows.filter((r) => r.status === "DRAFT");
  const missing = draft.filter((r) => rowErrors(r).length);
  const locked = rows.filter((r) => r.status === "LOCKED").length;
  const sections = [...new Set(rows.map((r) => r.section))] as Section[];
  const unmatched = unmatchedShops(rows);

  return (
    <div className="max-w-[1500px]">
      <PageHead no={31} title="Đối chiếu thu chi">
        <span className="text-sm text-muted">File báo cáo tháng trên Drive → kiểm, gắn shop / TK → chốt thành Sổ quỹ</span>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />

      {/* chọn team / tháng */}
      <div className="mt-4 space-y-2">
        {[...new Set(sources.map((s) => s.team))].map((team) => (
          <div key={team} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-16 font-semibold">{team}</span>
            {sources.filter((s) => s.team === team).map((s) => {
              const d = cnt(s.source, "DRAFT");
              const l = cnt(s.source, "LOCKED");
              const done = d === 0 && l > 0;
              return (
                <Link key={s.source} href={`/doi-chieu-thu-chi?nguon=${s.source}`} className={`rounded-md border px-3 py-1 ${s.source === src.source ? "border-accent bg-accent text-white" : "border-hair bg-surface hover:bg-page"}`}>
                  T{s.month}/{s.year} {done ? "🔒" : l ? `· ${l} đã chốt` : ""}
                  {s.warnings.length > 0 && !done && <span className={s.source === src.source ? "" : "text-amber-600"}> ⚠</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <section className="card overflow-x-auto p-5">
          <h2 className="font-bold">Đối chiếu {src.team} tháng {src.month}/{src.year} (USD)</h2>
          <table className="tbl mt-2 text-sm">
            <thead><tr><th>Mục</th><th className="text-right">Trong file</th><th className="text-right">Các dòng</th><th className="text-right">Lệch</th></tr></thead>
            <tbody>
              {recon.map((r) => {
                const big = r.diff !== null && Math.abs(r.diff) >= 1;
                return (
                  <tr key={r.key} className={["THU", "CHI", "LOI_NHUAN"].includes(r.key) ? "bg-page font-semibold" : ""}>
                    <td>{r.label}</td>
                    <td className="text-right tabular-nums">{r.fileUsd === null ? "—" : usd(r.fileUsd)}</td>
                    <td className="text-right tabular-nums">{usd(r.linesUsd)}</td>
                    <td className={`text-right tabular-nums ${big ? "font-semibold text-crit" : "text-good"}`}>{r.diff === null ? "" : big ? usd(r.diff) : "khớp"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">Dòng VND quy USD theo tỷ giá tháng. Lệch nhỏ do làm tròn tỷ giá là bình thường; lệch lớn = file tự cộng sai hoặc có dòng bỏ qua.</p>
        </section>
        <section className="card p-5 text-sm">
          <h2 className="font-bold">Ghi chú khi đọc file</h2>
          <p className="mt-1 break-all text-xs text-muted">{src.file}</p>
          <ul className="mt-2 space-y-1">
            {src.warnings.map((w, i) => <li key={i} className="text-amber-700">⚠ {w}</li>)}
            {!src.warnings.length && <li className="text-good">✓ Các sheet chi tiết cộng khớp dòng tổng.</li>}
          </ul>
          {unmatched.length > 0 && (
            <div className="mt-3 rounded-md bg-amber-50 p-3">
              <div className="font-semibold">Shop trong file chưa có trong danh mục ({unmatched.length})</div>
              <ul className="mt-1 text-xs">
                {unmatched.map((u) => <li key={u.name}>{u.name} — {u.rows} dòng · {usd(u.usd)} $</li>)}
              </ul>
              <p className="mt-1 text-xs text-ink-2">
                Tạo ở <Link className="text-accent hover:underline" href="/shop?edit=new">màn 16</Link> (tên giống trong file) rồi bấm ghép lại; hoặc chọn TK ghi Có 401 nếu không theo dõi theo shop.
              </p>
              {canWrite && (
                <form action={rematchAction.bind(null, src.source)} className="mt-2"><button className="btn" type="submit">Ghép lại shop</button></form>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-3">
            <Badge tone={missing.length ? "crit" : "accent"}>{missing.length ? `${missing.length} dòng còn thiếu` : `${draft.length} dòng đủ, chờ chốt`}</Badge>
            {locked > 0 && <Badge tone="good">{locked} dòng đã chốt</Badge>}
            {rows.some((r) => r.status === "SKIP") && <Badge>{rows.filter((r) => r.status === "SKIP").length} dòng bỏ qua</Badge>}
          </div>
          <p className="mt-3 text-xs text-muted">
            Chốt: mọi dòng chưa bỏ qua phải đủ tài khoản; thu cần shop (hoặc TK ghi Có khi không theo shop); chi cần hạng mục. Mỗi dòng thành một giao dịch Sổ quỹ ngày ghi
            trên dòng (khoản không có ngày = cuối tháng), rồi khoá. Sửa sau khi chốt: huỷ giao dịch ở Sổ quỹ.
          </p>
        </section>
      </div>

      <form action={saveAction.bind(null, src.source)} className="mt-4">
        {canWrite && draft.length > 0 && (
          <div className="card flex flex-wrap items-end gap-3 p-4 text-sm">
            <div>
              <label className="label" htmlFor="rate">Tỷ giá tháng (VND/USD)</label>
              <input className="input w-32" id="rate" name="rate" defaultValue={rate ? String(rate) : ""} inputMode="decimal" />
            </div>
            <div>
              <label className="label" htmlFor="bulkAccount">Gán tài khoản cho dòng còn trống</label>
              <select className="input" id="bulkAccount" name="bulkAccount" defaultValue="">
                <option value="">—</option>
                {accounts.map((a) => <option key={a.id} value={a.id} disabled={!a.active}>{a.provider.name} · {a.code} ({a.currency}){a.active ? "" : " — ngưng dùng, bật ở màn 8"}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="bulkSection">thuộc mục</label>
              <select className="input" id="bulkSection" name="bulkSection" defaultValue="">
                <option value="">Mọi mục</option>
                {sections.map((s) => <option key={s} value={s}>{SECTION_VI[s]}</option>)}
              </select>
            </div>
            <div className="ml-auto flex gap-2">
              <button className="btn" type="submit" name="intent" value="save">Lưu</button>
              <button className="btn btn-primary" type="submit" name="intent" value="commit">Lưu & chốt {draft.length} dòng</button>
            </div>
          </div>
        )}

        <div className="card mt-3 overflow-x-auto">
          <table className="tbl text-sm">
            <thead>
              <tr>
                <th>#</th><th>Ngày</th><th>Mục / nội dung</th><th className="text-right">Số tiền</th><th>Tài khoản</th><th>Shop / TK ghi Có · Hạng mục / NCC</th><th>Bỏ qua</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((sec) => [
                <tr key={`h-${sec}`} className="bg-page"><td colSpan={7} className="font-semibold">{SECTION_VI[sec]}</td></tr>,
                ...rows.filter((r) => r.section === sec).map((r) => {
                  const lockedRow = r.status === "LOCKED" || !canWrite;
                  const errs = r.status === "DRAFT" ? rowErrors(r) : [];
                  const n = (k: string) => `${r.id}.${k}`;
                  const sel = (k: string, value: string | null, opts: { value: string; label: string; disabled?: boolean }[], label: string, warn: boolean) => (
                    <select className={`input min-w-44 ${warn ? "border-crit bg-red-50" : ""}`} name={n(k)} defaultValue={value ?? ""} disabled={lockedRow} aria-label={label}>
                      <option value="">— {label}</option>
                      {opts.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
                    </select>
                  );
                  return (
                    <tr key={r.id} className={r.status === "SKIP" ? "opacity-50" : r.status === "LOCKED" ? "bg-green-50/40" : ""}>
                      <td className="text-xs text-muted">{r.line}</td>
                      <td><input className="input w-36" type="date" name={n("date")} defaultValue={bizDateStr(r.date)} disabled={lockedRow} aria-label="Ngày" /></td>
                      <td className="min-w-64">
                        <div className={r.direction === "IN" ? "text-good" : ""}>{r.direction === "IN" ? "＋" : "－"} {r.label}</div>
                        {r.note && <div className="text-xs text-ink-2">{r.note}</div>}
                        {r.ref && <div className="text-[11px] text-muted">{r.ref}</div>}
                        {errs.length > 0 && <div className="text-xs text-crit">Thiếu: {errs.join(", ")}</div>}
                      </td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <input className="input w-36 text-right" name={n("amount")} defaultValue={major(r.amount, r.currency)} disabled={lockedRow} inputMode="decimal" aria-label="Số tiền" />
                          <span className="w-8 text-xs text-muted">{r.currency}</span>
                        </div>
                        {r.currency === "VND" && rate > 0 && <div className="text-[11px] text-muted">≈ {usd(Number(r.amount) / rate)} $</div>}
                      </td>
                      <td>{sel("account", r.accountId, accounts.map((a) => ({ value: a.id, label: `${a.provider.name} · ${a.code} (${a.currency})${a.active ? "" : " — ngưng dùng"}`, disabled: !a.active })), "Tài khoản", r.status === "DRAFT" && !r.accountId)}</td>
                      <td>
                        {r.direction === "IN" ? (
                          <div className="flex flex-col gap-1">
                            {sel("shop", r.shopId, shops.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` })), "Shop", r.status === "DRAFT" && !r.shopId && !r.incomeGl)}
                            {sel("gl", r.incomeGl, glAccounts.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` })), "TK ghi Có (nếu không theo shop)", false)}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {sel("cat", r.categoryId, cats.map((c) => ({ value: c.id, label: c.name })), "Hạng mục", r.status === "DRAFT" && !r.categoryId)}
                            {(r.section === "FULFILL" || r.supplierId) && sel("sup", r.supplierId, sups.map((s) => ({ value: s.id, label: s.name })), "NCC", false)}
                          </div>
                        )}
                      </td>
                      <td className="text-center">
                        {r.status === "LOCKED" ? (
                          <Link className="text-xs text-good hover:underline" href={`/so-quy?from=${bizDateStr(r.date)}&to=${bizDateStr(r.date)}`}>🔒 Sổ quỹ</Link>
                        ) : (
                          <input type="checkbox" name={n("skip")} defaultChecked={r.status === "SKIP"} disabled={lockedRow} aria-label="Bỏ qua" />
                        )}
                      </td>
                    </tr>
                  );
                }),
              ])}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          Số tiền theo đơn vị trong file (USD có 2 số lẻ); tài khoản khác loại tiền thì quy đổi theo tỷ giá tháng khi chốt. Thu không theo shop (Amazon chưa có shop, hoàn tiền NCC,
          cho thuê TK): chọn TK ghi Có thay cho shop.
        </p>
      </form>
    </div>
  );
}
