import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { channelLabel } from "@/lib/channels";
import { daysBetween, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { SHOP_STATUS_LABEL, troubleStats, TROUBLE, type ShopStatus } from "@/lib/shops";
import { Badge, PageHead } from "../ui";

const label = (s: string) => SHOP_STATUS_LABEL[s as ShopStatus] ?? s;

/** Màn 18 — lịch sử đổi trạng thái shop, tần suất sự cố theo kênh và theo người phụ trách. */
export default async function ShopHealthPage() {
  await requireUser(["ADMIN", "QUAN_LY"]);
  const today = todayVn();
  const [shops, events, users] = await Promise.all([
    prisma.shop.findMany({ orderBy: { code: "asc" } }),
    prisma.shopHealthEvent.findMany({ include: { shop: true }, orderBy: [{ at: "desc" }, { id: "desc" }], take: 300 }),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const byChannel = troubleStats(shops.map((s) => ({ id: s.id, key: channelLabel(s.channel) })), events);
  const byOwner = troubleStats(shops.map((s) => ({ id: s.id, key: s.ownerId ? userName.get(s.ownerId) ?? "?" : "(chưa giao)" })), events);
  const troubled = shops.filter((s) => (TROUBLE as string[]).includes(s.status));
  // Thời gian đã ở trạng thái sự cố hiện tại (từ sự kiện gần nhất).
  const since = new Map<string, Date>();
  for (const e of events) if (!since.has(e.shopId)) since.set(e.shopId, e.at);

  const statTable = (title: string, rows: ReturnType<typeof troubleStats>) => (
    <section className="card p-5">
      <h2 className="font-bold">{title}</h2>
      <table className="tbl mt-2">
        <thead><tr><th>Nhóm</th><th className="text-right">Số shop</th><th className="text-right">Lần gặp sự cố</th><th className="text-right">Trung bình / shop</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              <td className="text-right tabular-nums">{r.shops}</td>
              <td className={`text-right tabular-nums ${r.incidents ? "font-semibold" : ""}`}>{r.incidents}</td>
              <td className="text-right tabular-nums">{r.perShop.toLocaleString("vi-VN", { maximumFractionDigits: 2 })}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={4} className="py-4 text-center text-muted">Chưa có shop.</td></tr>}
        </tbody>
      </table>
    </section>
  );

  return (
    <div className="max-w-6xl">
      <PageHead no={18} title="Sức khoẻ shop" />
      <p className="mt-2 max-w-3xl text-sm text-ink-2">
        Shop là tài sản rủi ro nhất của mô hình. “Sự cố” = chuyển sang Đang bị xem xét, Bị treo hoặc Bị khoá. Đổi trạng thái ở{" "}
        <Link className="text-accent hover:underline" href="/shop">màn 16</Link>.
      </p>

      <div className={`mt-4 rounded-lg border p-4 ${troubled.length ? "border-crit/40 bg-red-50" : "border-hair bg-surface"}`}>
        {troubled.length ? (
          <>
            <p className="font-semibold text-crit">⛔ {troubled.length} shop đang gặp sự cố</p>
            <ul className="mt-1 text-sm">
              {troubled.map((s) => (
                <li key={s.id}>
                  {s.code} ({channelLabel(s.channel)}) — {label(s.status)}
                  {since.get(s.id) && <span className="text-ink-2"> · {daysBetween(since.get(s.id)!, today)} ngày</span>}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="font-semibold text-good">✓ Không shop nào đang bị xem xét / treo / khoá.</p>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {statTable("Theo kênh", byChannel)}
        {statTable("Theo người phụ trách", byOwner)}
      </div>

      <section className="mt-6">
        <h2 className="font-bold">Lịch sử đổi trạng thái</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Ngày</th><th>Shop</th><th>Từ</th><th>Sang</th><th>Ghi chú</th><th>Người ghi</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="tabular-nums">{fmtBizDate(e.at)}</td>
                  <td>{e.shop.code} <span className="text-xs text-muted">{channelLabel(e.shop.channel)}</span></td>
                  <td>{label(e.fromStatus)}</td>
                  <td><Badge tone={e.toStatus === "ACTIVE" ? "good" : (TROUBLE as string[]).includes(e.toStatus) ? "crit" : "muted"}>{label(e.toStatus)}</Badge></td>
                  <td>{e.note}</td>
                  <td className="text-xs text-muted">{e.createdBy ? userName.get(e.createdBy) ?? e.createdBy : ""}</td>
                </tr>
              ))}
              {!events.length && <tr><td colSpan={6} className="py-6 text-center text-muted">Chưa có lần đổi trạng thái nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
