import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { channelLabel } from "@/lib/channels";
import { bizDateStr, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { costsOf, FULFILL_STATUS_VI, marginOf, ORDER_STATUS_VI, pct, revenueOf, usd } from "@/lib/order-view";
import { Badge, Field, Flash } from "../../ui";
import { addFulfillmentAction, addRefundAction, cancelOrder, setFulfillStatus } from "../actions";

export default async function OrderDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const me = await requireUser(["ADMIN", "KE_TOAN", "QUAN_LY"]);
  const { id } = await params;
  const sp = await searchParams;
  const o = await prisma.order.findUnique({
    where: { id },
    include: {
      shop: true,
      items: { include: { variant: { include: { product: { include: { design: true } } } } } },
      cost: true,
      refunds: true,
      fulfillments: { include: { supplier: true }, orderBy: { submittedAt: "asc" } },
      payoutLines: { include: { payout: true } },
    },
  });
  if (!o) notFound();
  const suppliers = await prisma.supplier.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  const edit = me.role === "ADMIN" || me.role === "KE_TOAN";
  const mg = marginOf(o);
  const r = revenueOf(o);
  const c = costsOf(o);
  const refunded = o.refunds.reduce((a, x) => a + Number(x.amountUsd), 0);

  const waterfall: [string, number, boolean?][] = [
    ["Doanh thu", r.grossUsd],
    ["Giảm giá", -Number(o.discountUsd)],
    ...(refunded ? ([["Hoàn tiền", -refunded]] as [string, number][]) : []),
    ["Phí ship thu khách", r.shippingChargedUsd],
    ["Phí sàn", -r.platformFeeUsd],
    ["Thuế thu hộ", -r.taxUsd],
    ["Doanh thu ròng", mg.netRevenueUsd, true],
    ["Giá vốn fulfillment", -c.ffUsd],
    ["Ship", -c.shipUsd],
    ["Lãi gộp", mg.grossProfitUsd, true],
    ["Chi phí chung phân bổ", -c.overheadUsd],
    ["Lợi nhuận", mg.netProfitUsd, true],
  ];

  return (
    <div className="max-w-6xl">
      <Link href="/don-hang" className="text-sm text-accent hover:underline">← Đơn hàng</Link>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-muted">Màn hình 21</div>
          <h1 className="text-2xl font-bold">Đơn <span className="font-mono">{o.externalId}</span></h1>
          <p className="text-sm text-ink-2">{channelLabel(o.shop.channel)} · {o.shop.code} · đặt {fmtBizDate(o.orderedAt)}{o.country ? ` · ${o.country}` : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={o.status === "CANCELLED" || o.status === "REFUNDED" ? "crit" : "accent"}>{ORDER_STATUS_VI[o.status]}</Badge>
          {edit && o.status !== "CANCELLED" && <form action={cancelOrder.bind(null, o.id)}><button className="btn" type="submit">Huỷ đơn</button></form>}
        </div>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <section className="card overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>SKU</th><th>Sản phẩm / design</th><th className="text-right">SL</th><th className="text-right">Đơn giá</th></tr></thead>
              <tbody>
                {o.items.map((i) => (
                  <tr key={i.id}>
                    <td className="font-mono text-xs">{i.sku}</td>
                    <td>{i.variant ? `${i.variant.product.name}${i.variant.product.design ? ` · ${i.variant.product.design.code}` : ""}` : <span className="text-muted">chưa khai SKU</span>}</td>
                    <td className="text-right tabular-nums">{i.qty}</td>
                    <td className="text-right tabular-nums">{usd(Number(i.unitPriceUsd))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card p-5">
            <h2 className="font-bold">Đơn fulfill</h2>
            <table className="tbl mt-2 text-sm">
              <thead><tr><th>NCC</th><th>SKU</th><th>Mã</th><th>Ngày</th><th className="text-right">Giá vốn</th><th className="text-right">Bảng giá</th><th className="text-right">Ship</th><th>Trạng thái</th></tr></thead>
              <tbody>
                {o.fulfillments.map((f) => {
                  const listed = f.listedCostUsd === null ? null : Number(f.listedCostUsd);
                  const over = listed && listed > 0 ? (Number(f.costUsd) - listed) / listed : 0;
                  return (
                    <tr key={f.id}>
                      <td>{f.supplier.name}</td>
                      <td className="font-mono text-xs">{f.sku ?? "—"}</td>
                      <td className="text-xs">{f.externalId ?? "—"}{f.trackingNo && <div className="text-muted">{f.trackingNo}</div>}</td>
                      <td className="tabular-nums">{f.submittedAt ? fmtBizDate(f.submittedAt) : ""}</td>
                      <td className={`text-right tabular-nums ${over > 0.05 ? "font-semibold text-crit" : ""}`}>{usd(Number(f.costUsd))}</td>
                      <td className="text-right tabular-nums text-ink-2">{listed === null ? "—" : <>{usd(listed)}{over > 0.05 && <div className="text-xs text-crit">+{pct(over)}</div>}</>}</td>
                      <td className="text-right tabular-nums">{usd(Number(f.shipUsd))}</td>
                      <td>
                        {edit ? (
                          <form action={setFulfillStatus.bind(null, o.id, f.id)} className="flex gap-1">
                            <select className="input w-32" name="status" defaultValue={f.status} aria-label="Trạng thái">
                              {Object.entries(FULFILL_STATUS_VI).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                            <button className="btn" type="submit">Lưu</button>
                          </form>
                        ) : FULFILL_STATUS_VI[f.status]}
                      </td>
                    </tr>
                  );
                })}
                {!o.fulfillments.length && <tr><td colSpan={8} className="py-4 text-center text-crit">Chưa ghép đơn fulfill — giá vốn đang là 0, biên lãi đang ảo.</td></tr>}
              </tbody>
            </table>
            {edit && (
              <form action={addFulfillmentAction.bind(null, o.id)} className="mt-4 grid gap-3 border-t border-hair pt-4 sm:grid-cols-4">
                <Field name="supplierId" label="NCC" required empty="Chọn…" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
                <Field name="sku" label="SKU" placeholder={o.items.length === 1 ? o.items[0].sku : "SKU"} help="Trống = SKU duy nhất của đơn" />
                <Field name="externalId" label="Mã đơn NCC" />
                <Field name="submittedAt" label="Ngày đặt" type="date" defaultValue={bizDateStr(todayVn())} />
                <Field name="costUsd" label="Giá vốn (USD)" required inputMode="decimal" />
                <Field name="shipUsd" label="Ship (USD)" inputMode="decimal" />
                <Field name="trackingNo" label="Tracking" />
                <div className="flex items-end"><button className="btn-primary" type="submit">Ghép</button></div>
              </form>
            )}
          </section>

          <section className="card p-5">
            <h2 className="font-bold">Hoàn tiền & tiền về</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {o.refunds.map((x) => <li key={x.id}>Hoàn {usd(Number(x.amountUsd))} ngày {fmtBizDate(x.refundedAt)}{x.reason && ` — ${x.reason}`}</li>)}
              {o.payoutLines.map((l) => (
                <li key={l.id}>Payout kỳ {fmtBizDate(l.payout.periodFrom)}–{fmtBizDate(l.payout.periodTo)}: {usd(Number(l.amountUsd))} ({l.kind}) {l.payout.cashTxnId ? <Badge tone="good">đã về Sổ quỹ</Badge> : <Badge>chưa ghi</Badge>}</li>
              ))}
              {!o.refunds.length && !o.payoutLines.length && <li className="text-muted">Chưa có hoàn tiền, chưa nằm trong payout nào.</li>}
            </ul>
            {edit && o.status !== "REFUNDED" && (
              <form action={addRefundAction.bind(null, o.id)} className="mt-3 grid gap-3 border-t border-hair pt-3 sm:grid-cols-4">
                <Field name="refundedAt" label="Ngày hoàn" type="date" required defaultValue={bizDateStr(todayVn())} />
                <Field name="amountUsd" label="Số tiền (USD)" required inputMode="decimal" />
                <Field name="reason" label="Lý do" />
                <div className="flex items-end"><button className="btn" type="submit">Ghi hoàn tiền</button></div>
              </form>
            )}
          </section>
        </div>

        <aside className="card h-fit p-5">
          <h2 className="font-bold">Biên lãi đơn này</h2>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {waterfall.map(([label, v, strong]) => (
                <tr key={label} className={strong ? "border-t border-hair font-semibold" : ""}>
                  <td className="py-1">{label}</td>
                  <td className={`py-1 text-right tabular-nums ${strong && v < 0 ? "text-crit" : ""}`}>{v === 0 && !strong ? <span className="text-muted">—</span> : usd(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted">
            Tỷ lệ FF {mg.netRevenueUsd > 0 ? pct(mg.ffRatio) : "—"} · biên ròng {mg.netRevenueUsd > 0 ? pct(mg.netMarginPct) : "—"}. Chi phí chung chia theo tỷ trọng doanh thu ròng trong tháng.
          </p>
        </aside>
      </div>
    </div>
  );
}
