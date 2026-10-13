import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { channelLabel, CHANNELS } from "@/lib/channels";
import { dayOfMonth, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { FF_RATIO_WARN } from "@/lib/margin";
import { marginOf, ORDER_STATUS_VI, pct, usd } from "@/lib/order-view";
import { Badge, Field, Flash, PageHead } from "../ui";
import { recomputeMonth } from "./actions";

type SP = { thang?: string; shop?: string; ch?: string; loc?: string; q?: string; ok?: string; error?: string };

/** Màn 21 — đơn hàng theo tháng, lọc shop / kênh / biên lãi, biên lãi từng đơn. */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireUser(["ADMIN", "KE_TOAN", "QUAN_LY"]);
  const sp = await searchParams;
  const today = todayVn();
  const m = /^(\d{4})-(\d{2})$/.exec(sp.thang ?? "");
  const year = m ? +m[1] : today.getUTCFullYear();
  const month = m ? +m[2] : today.getUTCMonth() + 1;
  const thang = `${year}-${String(month).padStart(2, "0")}`;
  const loc = sp.loc ?? "";

  const shops = await prisma.shop.findMany({ orderBy: [{ channel: "asc" }, { code: "asc" }] });
  const where: Prisma.OrderWhereInput = {
    orderedAt: { gte: dayOfMonth(year, month - 1, 1), lte: dayOfMonth(year, month - 1, 31) },
    ...(sp.shop ? { shopId: sp.shop } : sp.ch ? { shop: { channel: sp.ch } } : {}),
    ...(sp.q ? { externalId: { contains: sp.q.trim() } } : {}),
    ...(loc === "chua-ghep" ? { fulfillments: { none: {} }, status: { notIn: ["CANCELLED", "REFUNDED"] } } : {}),
  };
  const orders = await prisma.order.findMany({
    where,
    include: { cost: true, refunds: true, shop: true, _count: { select: { fulfillments: true, items: true } } },
    orderBy: [{ orderedAt: "desc" }, { externalId: "asc" }],
    take: 1000,
  });
  let rows = orders.map((o) => ({ o, mg: marginOf(o) }));
  if (loc === "lo") rows = rows.filter((r) => r.mg.netProfitUsd < 0);
  if (loc === "ff-cao") rows = rows.filter((r) => r.mg.ffRatio > FF_RATIO_WARN);

  const sum = rows.reduce(
    (a, { o, mg }) => ({ net: a.net + mg.netRevenueUsd, ff: a.ff + Number(o.cost?.ffCostUsd ?? 0), profit: a.profit + mg.netProfitUsd, loss: a.loss + (mg.netProfitUsd < 0 ? 1 : 0) }),
    { net: 0, ff: 0, profit: 0, loss: 0 },
  );
  const keep = new URLSearchParams(Object.entries({ thang, shop: sp.shop ?? "", ch: sp.ch ?? "", loc, q: sp.q ?? "" }).filter(([, v]) => v));

  return (
    <div className="max-w-7xl">
      <PageHead no={21} title={`Đơn hàng tháng ${month}/${year}`}>
        {(me.role === "ADMIN" || me.role === "KE_TOAN") && (
          <div className="flex gap-2">
            <Link className="btn" href="/import-don">Import đơn</Link>
            <form action={recomputeMonth.bind(null, thang)}><button className="btn" type="submit">Tính lại giá vốn tháng</button></form>
          </div>
        )}
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />

      <form method="get" className="card mt-4 grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Field name="thang" label="Tháng" type="month" defaultValue={thang} />
        <Field name="ch" label="Kênh" empty="Tất cả" defaultValue={sp.ch} options={CHANNELS.map((c) => ({ value: c.code, label: c.label }))} />
        <Field name="shop" label="Shop" empty="Tất cả" defaultValue={sp.shop} options={shops.map((s) => ({ value: s.id, label: `${channelLabel(s.channel)} · ${s.code}` }))} />
        <Field
          name="loc"
          label="Lọc"
          empty="Tất cả đơn"
          defaultValue={loc}
          options={[
            { value: "lo", label: "Đơn lỗ (sau phân bổ)" },
            { value: "ff-cao", label: `FF > ${Math.round(FF_RATIO_WARN * 100)}%` },
            { value: "chua-ghep", label: "Chưa ghép đơn fulfill" },
          ]}
        />
        <Field name="q" label="Mã đơn" defaultValue={sp.q} />
        <div className="flex items-end gap-2"><button className="btn-primary" type="submit">Lọc</button><Link className="btn" href="/don-hang">Xoá</Link></div>
      </form>

      <div className="mt-3 flex flex-wrap gap-x-5 text-sm">
        <span>{rows.length} đơn</span>
        <span>Doanh thu ròng <strong>{usd(sum.net)}</strong></span>
        <span>FF <strong>{usd(sum.ff)}</strong> ({sum.net > 0 ? pct(sum.ff / sum.net) : "—"})</span>
        <span>Lợi nhuận sau phân bổ <strong className={sum.profit < 0 ? "text-crit" : "text-good"}>{usd(sum.profit)}</strong></span>
        {sum.loss > 0 && <span className="text-crit">{sum.loss} đơn lỗ</span>}
      </div>

      <div className="card mt-2 overflow-x-auto">
        <table className="tbl text-xs [&_td]:whitespace-nowrap">
          <thead>
            <tr>
              <th>Ngày</th><th>Shop</th><th>Mã đơn</th><th className="text-right">Doanh thu ròng</th><th className="text-right">FF</th><th className="text-right">Ship</th>
              <th className="text-right">CP chung</th><th className="text-right">Lợi nhuận</th><th className="text-right">Biên</th><th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ o, mg }) => (
              <tr key={o.id}>
                <td className="tabular-nums">{fmtBizDate(o.orderedAt)}</td>
                <td>{o.shop.code}</td>
                <td><Link className="font-mono text-accent hover:underline" href={`/don-hang/${o.id}?${keep}`}>{o.externalId}</Link>{o._count.items > 1 && <span className="text-muted"> · {o._count.items} món</span>}</td>
                <td className="text-right tabular-nums">{usd(mg.netRevenueUsd)}</td>
                <td className={`text-right tabular-nums ${mg.ffRatio > FF_RATIO_WARN ? "text-crit" : ""}`}>{o._count.fulfillments ? usd(Number(o.cost?.ffCostUsd ?? 0)) : <Badge tone="crit">chưa ghép</Badge>}</td>
                <td className="text-right tabular-nums">{usd(Number(o.cost?.shipCostUsd ?? 0))}</td>
                <td className="text-right tabular-nums text-ink-2">{usd(Number(o.cost?.overheadUsd ?? 0))}</td>
                <td className={`text-right font-semibold tabular-nums ${mg.netProfitUsd < 0 ? "text-crit" : ""}`}>{usd(mg.netProfitUsd)}</td>
                <td className={`text-right tabular-nums ${mg.netMarginPct < 0 ? "text-crit" : ""}`}>{mg.netRevenueUsd > 0 ? pct(mg.netMarginPct) : "—"}</td>
                <td>{ORDER_STATUS_VI[o.status]}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={10} className="py-8 text-center text-muted">Không có đơn nào.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        CP chung = chi phí hoạt động trên sổ cái (TK 60x) của tháng, quy USD, chia cho từng đơn theo tỷ trọng doanh thu ròng — là một cách chia, không phải sự thật.
        Đơn huỷ / hoàn toàn bộ không gánh. Hoàn tiền một phần được trừ vào doanh thu.
      </p>
    </div>
  );
}
