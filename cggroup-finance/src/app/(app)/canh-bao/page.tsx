import Link from "next/link";
import { loadAllAlerts, syncAlertLog } from "@/lib/alerts";
import { requireUser } from "@/lib/auth";
import { todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { Badge, Flash, PageHead } from "../ui";
import { acknowledgeAction } from "./actions";

type SP = { xem?: string; ok?: string; error?: string };
const LEVEL = { ERROR: { tone: "crit", label: "Nghiêm trọng" }, WARN: { tone: "accent", label: "Cần xem" }, INFO: { tone: "muted", label: "Gợi ý" } } as const;
const ts = (d: Date) => d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" });
const dur = (a: Date, b: Date) => {
  const h = Math.round((b.getTime() - a.getTime()) / 3_600_000);
  return h < 48 ? `${h} giờ` : `${Math.round(h / 24)} ngày`;
};

/** Màn 28 — cảnh báo đang mở, ai đã nhận xử lý, lịch sử. Mở trang = quét lại toàn bộ cảnh báo. */
export default async function AlertCenterPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireUser(["ADMIN", "KE_TOAN", "QUAN_LY"]);
  const sp = await searchParams;
  const history = sp.xem === "lich-su";

  const sync = await syncAlertLog(prisma, await loadAllAlerts(prisma, todayVn()));
  const [open, closed, users, lastJob] = await Promise.all([
    prisma.alertLog.findMany({ where: { resolvedAt: null }, orderBy: [{ level: "desc" }, { firedAt: "asc" }] }),
    history ? prisma.alertLog.findMany({ where: { resolvedAt: { not: null } }, orderBy: { resolvedAt: "desc" }, take: 100 }) : Promise.resolve([]),
    prisma.user.findMany({ select: { id: true, name: true } }),
    prisma.auditLog.findFirst({ where: { tableName: "AlertJob" }, orderBy: { at: "desc" } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const unacked = open.filter((o) => !o.acknowledgedAt).length;

  return (
    <div className="max-w-7xl">
      <PageHead no={28} title="Trung tâm cảnh báo">
        <span className="text-sm text-muted">
          Job hằng ngày lần cuối: {lastJob ? ts(lastJob.at) : "chưa chạy"} · vừa quét: +{sync.opened} mới, {sync.resolved} hết
        </span>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="card p-4"><div className="text-xs text-ink-2">Đang mở</div><div className="mt-1 text-2xl font-bold">{open.length}</div></div>
        <div className={`card p-4 ${open.some((o) => o.level === "ERROR") ? "border-crit/40 bg-red-50" : ""}`}>
          <div className="text-xs text-ink-2">Nghiêm trọng</div><div className="mt-1 text-2xl font-bold">{open.filter((o) => o.level === "ERROR").length}</div>
        </div>
        <div className="card p-4"><div className="text-xs text-ink-2">Chưa ai nhận</div><div className={`mt-1 text-2xl font-bold ${unacked ? "text-crit" : ""}`}>{unacked}</div></div>
      </div>

      <div className="mt-4 flex gap-2 text-sm">
        <Link href="/canh-bao" className={`rounded-md px-3 py-1.5 ${!history ? "bg-accent text-white" : "bg-surface hover:bg-page"}`}>Đang mở</Link>
        <Link href="/canh-bao?xem=lich-su" className={`rounded-md px-3 py-1.5 ${history ? "bg-accent text-white" : "bg-surface hover:bg-page"}`}>Lịch sử</Link>
      </div>

      {!history ? (
        <ul className="mt-3 space-y-2">
          {open.map((a) => (
            <li key={a.id} className={`card p-4 text-sm ${a.level === "ERROR" ? "border-crit/40" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={LEVEL[a.level].tone}>{LEVEL[a.level].label}</Badge>
                <span className="font-semibold">{a.title}</span>
                <span className="ml-auto text-xs text-muted">mở từ {ts(a.firedAt)} ({dur(a.firedAt, new Date())})</span>
              </div>
              <p className="mt-1 text-ink-2">{a.detail}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {a.href && <Link className="text-accent hover:underline" href={a.href}>Đi xử lý →</Link>}
                {a.acknowledgedAt ? (
                  <span className="text-xs text-good">✓ {userName.get(a.acknowledgedBy ?? "") ?? a.acknowledgedBy} đã nhận lúc {ts(a.acknowledgedAt)}</span>
                ) : (
                  <form action={acknowledgeAction.bind(null, a.id)}><button className="btn" type="submit">Tôi nhận xử lý</button></form>
                )}
              </div>
            </li>
          ))}
          {!open.length && <li className="card p-6 text-center text-sm text-good">✓ Không có cảnh báo nào đang mở.</li>}
        </ul>
      ) : (
        <div className="card mt-3 overflow-x-auto">
          <table className="tbl text-sm">
            <thead><tr><th>Mức</th><th>Cảnh báo</th><th>Mở</th><th>Hết lúc</th><th>Kéo dài</th><th>Người nhận</th></tr></thead>
            <tbody>
              {closed.map((a) => (
                <tr key={a.id}>
                  <td><Badge tone={LEVEL[a.level].tone}>{LEVEL[a.level].label}</Badge></td>
                  <td>{a.title}</td>
                  <td className="whitespace-nowrap text-xs">{ts(a.firedAt)}</td>
                  <td className="whitespace-nowrap text-xs">{ts(a.resolvedAt!)}</td>
                  <td className="text-xs">{dur(a.firedAt, a.resolvedAt!)}</td>
                  <td className="text-xs">{a.acknowledgedBy ? userName.get(a.acknowledgedBy) ?? a.acknowledgedBy : <span className="text-muted">không ai nhận</span>}</td>
                </tr>
              ))}
              {!closed.length && <tr><td colSpan={6} className="py-4 text-center text-muted">Chưa có cảnh báo nào đã đóng.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Cảnh báo tự đóng khi số liệu đã được sửa (lần quét sau không còn bắn). Quét chạy mỗi lần mở màn 1 / màn 28 và mỗi sáng bằng job <code>npm run alerts:daily</code>.
        Bộ kiểm tra lệch số khi đóng sổ nằm ở màn 27.
      </p>
    </div>
  );
}
