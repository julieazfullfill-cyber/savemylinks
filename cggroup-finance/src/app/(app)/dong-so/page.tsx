import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { closingStatus } from "@/lib/closing-service";
import { bizDateStr, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Badge, Flash, PageHead } from "../ui";
import { closeAction, reopenAction, resolveCheckAction, runChecksAction } from "./actions";

type SP = { thang?: string; ok?: string; error?: string };
const LEVEL = { ERROR: { tone: "crit", label: "Lỗi — chặn đóng sổ" }, WARN: { tone: "accent", label: "Cảnh báo" }, INFO: { tone: "muted", label: "Thông tin" } } as const;
const STATUS_VI = { OPEN: "Đang mở", CHECKING: "Đang kiểm tra", CLOSED: "Đã đóng sổ" } as const;

/** Màn 27 — checklist đóng sổ, bộ kiểm tra lệch số, khoá kỳ, mở lại kỳ. */
export default async function ClosingPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireUser(["ADMIN", "KE_TOAN", "QUAN_LY"]);
  const sp = await searchParams;
  const today = todayVn();
  const def = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const thang = /^\d{4}-\d{2}$/.test(sp.thang ?? "") ? sp.thang! : bizDateStr(def).slice(0, 7);
  const [y, m] = thang.split("-").map(Number);
  const canWrite = me.role !== "QUAN_LY";

  const [st, history, users] = await Promise.all([
    prisma.$transaction((tx) => closingStatus(tx, y, m), { timeout: 30_000 }),
    prisma.periodClosing.findMany({ orderBy: [{ year: "desc" }, { month: "desc" }], take: 24 }),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const closed = st.closing?.status === "CLOSED";
  const results = st.lastRun?.results ?? [];
  const latestClosed = history.find((h) => h.status === "CLOSED");

  return (
    <div className="max-w-7xl">
      <PageHead no={27} title={`Đóng sổ tháng ${m}/${y}`}>
        <form method="get" className="flex items-end gap-2">
          <div><label className="label" htmlFor="thang">Tháng</label><input className="input" id="thang" name="thang" type="month" defaultValue={thang} /></div>
          <button className="btn" type="submit">Xem</button>
        </form>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Badge tone={closed ? "good" : "muted"}>{STATUS_VI[st.closing?.status ?? "OPEN"]}</Badge>
        {closed && st.closing?.closedAt && (
          <span className="text-sm text-ink-2">
            bởi {userName.get(st.closing.closedBy ?? "") ?? st.closing.closedBy} lúc {st.closing.closedAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · lợi nhuận{" "}
            <strong className={(st.closing.profitVnd ?? 0n) < 0n ? "text-crit" : ""}>{formatMoney(st.closing.profitVnd ?? 0n)}</strong> đã kết chuyển về 302
          </span>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <section className="card p-5">
          <h2 className="font-bold">Checklist</h2>
          <ol className="mt-3 space-y-3">
            {st.steps.map((s) => (
              <li key={s.code} className="flex gap-3 text-sm">
                <span aria-hidden className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold ${s.done ? "bg-green-100 text-good" : s.blocking ? "bg-red-100 text-crit" : "bg-page text-muted"}`}>
                  {s.done ? "✓" : s.blocking ? "!" : "–"}
                </span>
                <div>
                  <div className="font-medium">
                    {s.href ? <Link className="hover:text-accent" href={s.href}>{s.title}</Link> : s.title}
                    {!s.blocking && <span className="text-xs font-normal text-muted"> (không chặn)</span>}
                  </div>
                  {s.detail && <div className="text-xs text-ink-2">{s.detail}</div>}
                </div>
              </li>
            ))}
          </ol>
          {canWrite && !closed && (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-hair pt-4">
              <form action={runChecksAction.bind(null, thang)}><button className="btn" type="submit">Chạy kiểm tra</button></form>
              <form action={closeAction.bind(null, thang)}>
                <button className="btn btn-primary disabled:opacity-50" type="submit" disabled={!st.canClose} title={st.canClose ? "" : "Còn bước chặn chưa xong"}>
                  Đóng sổ & khoá kỳ {m}/{y}
                </button>
              </form>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            Đóng sổ: chạy lại bộ kiểm tra, ghi bút toán kết chuyển lãi lỗ về 302, chụp P&L + bảng cân đối, rồi khoá — không ghi thêm bút toán nào vào tháng này.
            Huỷ giao dịch thuộc kỳ đã đóng thì bút toán đảo ghi vào ngày huỷ.
          </p>
        </section>

        <section className="card p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-bold">Bộ kiểm tra lệch số liệu</h2>
            {st.lastRun && <span className="text-xs text-muted">chạy lúc {st.lastRun.runAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} bởi {userName.get(st.lastRun.runBy ?? "") ?? "—"}</span>}
          </div>
          {!st.lastRun ? (
            <p className="mt-3 text-sm text-muted">Chưa chạy kiểm tra cho tháng này.</p>
          ) : !results.length ? (
            <p className="mt-3 text-sm text-good">✓ Cả 7 kiểm tra đều qua: sổ cái cân, lương khớp bảng lương, số dư khớp số chốt, hoá đơn NCC khớp đơn fulfill, không có số lệch bậc độ lớn, đơn đều có giá vốn, không chi thưởng trong tháng lỗ.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {results.map((r) => (
                <li key={r.id} className={`rounded-md border p-3 text-sm ${r.level === "ERROR" ? "border-crit/40 bg-red-50" : "border-hair"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={LEVEL[r.level].tone}>{LEVEL[r.level].label}</Badge>
                    <span className="font-semibold">{r.title}</span>
                    {r.href && <Link className="ml-auto text-xs text-accent hover:underline" href={r.href}>Đi sửa →</Link>}
                  </div>
                  <p className="mt-1 text-ink-2">{r.detail}</p>
                  {r.resolved ? (
                    <p className="mt-1 text-xs text-good">✓ Đã xem: {r.note} — {userName.get(r.resolvedBy ?? "") ?? r.resolvedBy}</p>
                  ) : (
                    canWrite && !closed && r.level !== "ERROR" && (
                      <form action={resolveCheckAction.bind(null, thang, r.id)} className="mt-2 flex flex-wrap gap-2">
                        <input className="input max-w-sm" name="note" required placeholder="Lý do chấp nhận (VD: NCC tính phí ship gộp)" aria-label="Lý do chấp nhận" />
                        <button className="btn" type="submit">Đã xem, chấp nhận</button>
                      </form>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">Lỗi mức ERROR không bỏ qua được — sửa số liệu ở màn gốc rồi chạy lại. Cảnh báo WARN ghi lý do là đóng được.</p>
        </section>
      </div>

      <section className="mt-6">
        <h2 className="font-bold">Lịch sử đóng sổ</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl text-sm">
            <thead>
              <tr><th>Kỳ</th><th>Trạng thái</th><th className="text-right">Doanh thu</th><th className="text-right">Giá vốn</th><th className="text-right">Chi phí</th><th className="text-right">Lợi nhuận</th><th>Đóng lúc</th></tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td><Link className="text-accent hover:underline" href={`/dong-so?thang=${h.year}-${String(h.month).padStart(2, "0")}`}>{h.month}/{h.year}</Link></td>
                  <td><Badge tone={h.status === "CLOSED" ? "good" : "muted"}>{STATUS_VI[h.status]}</Badge></td>
                  <td className="text-right tabular-nums">{h.revenueVnd !== null ? formatMoney(h.revenueVnd) : "—"}</td>
                  <td className="text-right tabular-nums">{h.cogsVnd !== null ? formatMoney(h.cogsVnd) : "—"}</td>
                  <td className="text-right tabular-nums">{h.expenseVnd !== null ? formatMoney(h.expenseVnd) : "—"}</td>
                  <td className={`text-right font-semibold tabular-nums ${(h.profitVnd ?? 0n) < 0n ? "text-crit" : ""}`}>{h.profitVnd !== null ? formatMoney(h.profitVnd) : "—"}</td>
                  <td className="text-xs text-muted">{h.closedAt?.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) ?? ""}</td>
                </tr>
              ))}
              {!history.length && <tr><td colSpan={7} className="py-4 text-center text-muted">Chưa đóng sổ kỳ nào.</td></tr>}
            </tbody>
          </table>
        </div>
        {me.role === "ADMIN" && latestClosed && latestClosed.year === y && latestClosed.month === m && (
          <form action={reopenAction.bind(null, thang)} className="card mt-4 p-5">
            <h3 className="font-bold">Mở lại kỳ {m}/{y}</h3>
            <p className="mt-1 text-sm text-ink-2">Chỉ Admin. Đảo bút toán kết chuyển, kỳ về trạng thái mở để sửa. Chỉ mở được kỳ đóng gần nhất. Lý do ghi vào nhật ký.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input className="input max-w-md" name="reason" required placeholder="Lý do mở lại" aria-label="Lý do mở lại" />
              <button className="btn" type="submit">Mở lại kỳ</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
