import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { channelLabel } from "@/lib/channels";
import { dayOfMonth, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { breakEvenRevenue, FF_RATIO_TARGET, FF_RATIO_WARN, groupMargin, type GroupMargin, type MarginRow } from "@/lib/margin";
import { costsOf, pct, revenueOf, usd } from "@/lib/order-view";
import { monthlyFixedCostUsd } from "@/lib/orders";
import { PageHead } from "../ui";

/** Màn 23 — xếp hạng shop và design theo lợi nhuận sau phân bổ chi phí chung; điểm hoà vốn. */
export default async function MarginPage({ searchParams }: { searchParams: Promise<{ tu?: string; den?: string }> }) {
  await requireUser(["ADMIN", "QUAN_LY", "KE_TOAN"]);
  const sp = await searchParams;
  const today = todayVn();
  const cur = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const ym = (s: string | undefined, d: string) => (/^\d{4}-\d{2}$/.test(s ?? "") ? s! : d);
  let tu = ym(sp.tu, cur);
  let den = ym(sp.den, cur);
  if (tu > den) [tu, den] = [den, tu];
  const [ty, tm] = tu.split("-").map(Number);
  const [dy, dm] = den.split("-").map(Number);

  const orders = await prisma.order.findMany({
    where: { orderedAt: { gte: dayOfMonth(ty, tm - 1, 1), lte: dayOfMonth(dy, dm - 1, 31) }, status: { not: "CANCELLED" } },
    include: { cost: true, refunds: true, shop: true, items: { include: { variant: { include: { product: { include: { design: true } } } } } } },
  });
  // Chi phí cố định cả kỳ = cộng từng tháng (TK 60x quy USD).
  let fixedUsd = 0;
  for (let y = ty, m = tm; y < dy || (y === dy && m <= dm); m === 12 ? ((m = 1), y++) : m++) {
    fixedUsd += (await prisma.$transaction((tx) => monthlyFixedCostUsd(tx, y, m))).usd;
  }

  const row = (key: string, o: (typeof orders)[number]): MarginRow => ({ key, revenue: revenueOf(o), costs: costsOf(o) });
  const byShop = groupMargin(orders.map((o) => row(`${o.shop.code}|${channelLabel(o.shop.channel)}`, o)));
  const byChannel = groupMargin(orders.map((o) => row(channelLabel(o.shop.channel), o)));
  // Design: theo design của mặt hàng đầu tiên (đơn nhiều design hiếm — ghi rõ bên dưới).
  const byDesign = groupMargin(orders.map((o) => row(o.items.find((i) => i.variant?.product.design)?.variant?.product.design?.code ?? "(chưa gắn design)", o)));

  const total = byChannel.reduce((a, g) => ({ rev: a.rev + g.netRevenueUsd, ff: a.ff + g.ffUsd, profit: a.profit + g.netProfitUsd }), { rev: 0, ff: 0, profit: 0 });
  const ffRatio = total.rev > 0 ? total.ff / total.rev : 0;
  const unmatched = orders.filter((o) => !o.cost || Number(o.cost.ffCostUsd) === 0).length;

  const table = (title: string, rows: GroupMargin[], split = false) => (
    <section className="card overflow-x-auto p-5">
      <h2 className="font-bold">{title}</h2>
      <table className="tbl mt-2 text-sm">
        <thead><tr><th>#</th><th>{title.replace("Theo ", "")}</th><th className="text-right">Đơn</th><th className="text-right">Doanh thu ròng</th><th className="text-right">Tỷ lệ FF</th><th className="text-right">Lãi gộp</th><th className="text-right">Lợi nhuận</th><th className="text-right">Biên</th></tr></thead>
        <tbody>
          {rows.map((g, i) => {
            const [name, sub] = split ? g.key.split("|") : [g.key, ""];
            return (
              <tr key={g.key}>
                <td className="text-muted">{i + 1}</td>
                <td>{name}{sub && <span className="text-xs text-muted"> · {sub}</span>}</td>
                <td className="text-right tabular-nums">{g.orders}</td>
                <td className="text-right tabular-nums">{usd(g.netRevenueUsd)}</td>
                <td className={`text-right tabular-nums ${g.ffRatio > FF_RATIO_WARN ? "font-semibold text-crit" : g.ffRatio <= FF_RATIO_TARGET ? "text-good" : ""}`}>{pct(g.ffRatio)}</td>
                <td className="text-right tabular-nums">{usd(g.grossProfitUsd)}</td>
                <td className={`text-right font-semibold tabular-nums ${g.netProfitUsd < 0 ? "text-crit" : ""}`}>{usd(g.netProfitUsd)}</td>
                <td className={`text-right tabular-nums ${g.netMarginPct < 0 ? "text-crit" : ""}`}>{pct(g.netMarginPct)}</td>
              </tr>
            );
          })}
          {!rows.length && <tr><td colSpan={8} className="py-4 text-center text-muted">Chưa có đơn trong kỳ.</td></tr>}
        </tbody>
      </table>
    </section>
  );

  return (
    <div className="max-w-7xl">
      <PageHead no={23} title="Biên lãi theo shop">
        <form method="get" className="flex items-end gap-2">
          <div><label className="label" htmlFor="tu">Từ tháng</label><input className="input" id="tu" name="tu" type="month" defaultValue={tu} /></div>
          <div><label className="label" htmlFor="den">Đến tháng</label><input className="input" id="den" name="den" type="month" defaultValue={den} /></div>
          <button className="btn" type="submit">Xem</button>
        </form>
      </PageHead>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card p-4"><div className="text-xs text-ink-2">Doanh thu ròng</div><div className="mt-1 text-xl font-semibold">{usd(total.rev)}</div><div className="text-xs text-muted">{orders.length} đơn</div></div>
        <div className={`card p-4 ${ffRatio > FF_RATIO_WARN ? "border-crit/40 bg-red-50" : ""}`}>
          <div className="text-xs text-ink-2">Tỷ lệ fulfillment</div>
          <div className={`mt-1 text-xl font-semibold ${ffRatio > FF_RATIO_WARN ? "text-crit" : ""}`}>{pct(ffRatio)}</div>
          <div className="text-xs text-muted">ngưỡng an toàn {pct(FF_RATIO_TARGET)}</div>
        </div>
        <div className="card p-4"><div className="text-xs text-ink-2">Chi phí cố định (TK 60x)</div><div className="mt-1 text-xl font-semibold">{usd(fixedUsd)}</div></div>
        <div className="card p-4">
          <div className="text-xs text-ink-2">Lợi nhuận sau phân bổ</div>
          <div className={`mt-1 text-xl font-semibold ${total.profit < 0 ? "text-crit" : "text-good"}`}>{usd(total.profit)}</div>
        </div>
      </div>

      {fixedUsd > 0 && total.rev > 0 && (
        <section className="card mt-4 p-5 text-sm">
          <h2 className="font-bold">Điểm hoà vốn</h2>
          <p className="mt-1 text-ink-2">
            Ở tỷ lệ FF hiện tại {pct(ffRatio)} cần <strong>{usd(breakEvenRevenue(fixedUsd, ffRatio))}</strong> doanh thu để hoà vốn (đang có {usd(total.rev)}).
            Kéo FF về {pct(FF_RATIO_TARGET)} thì chỉ cần <strong>{usd(breakEvenRevenue(fixedUsd, FF_RATIO_TARGET))}</strong>
            {breakEvenRevenue(fixedUsd, FF_RATIO_TARGET) <= total.rev && <> — <strong className="text-good">hết lỗ mà không cần bán thêm đơn nào</strong></>}.
            Mỗi 1 điểm % FF cắt được đáng khoảng {usd(total.rev / 100)}.
          </p>
        </section>
      )}
      {unmatched > 0 && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm">
          ⚠ {unmatched} đơn chưa có giá vốn fulfillment — lợi nhuận các đơn này đang bị thổi phồng. <Link className="text-accent hover:underline" href="/don-hang?loc=chua-ghep">Xem đơn chưa ghép</Link>
        </p>
      )}

      <div className="mt-4 space-y-4">
        {table("Theo kênh", byChannel)}
        {table("Theo shop", byShop, true)}
        {table("Theo design", byDesign)}
      </div>
      <p className="mt-2 text-xs text-muted">
        Chi phí chung (TK 60x trên sổ cái mỗi tháng, quy USD) chia cho từng đơn theo tỷ trọng doanh thu ròng — cách đơn giản và đủ dùng, nhưng shop doanh thu cao
        gánh nhiều hơn. Đơn huỷ không tính; hoàn tiền trừ vào doanh thu. Design tính theo design của mặt hàng đầu tiên trong đơn (khai SKU → sản phẩm → design để có dữ liệu).
      </p>
    </div>
  );
}
