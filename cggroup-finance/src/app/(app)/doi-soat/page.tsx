import { requireUser } from "@/lib/auth";
import { channelLabel } from "@/lib/channels";
import { addDays, bizDateStr, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { pct, usd } from "@/lib/order-view";
import { PAYOUT_SCHEDULE, reconcilePayout, RECONCILE_TOLERANCE, type Channel } from "@/lib/payout";
import { Badge, Field, Flash, PageHead } from "../ui";
import { createPayoutAction, postPayoutAction } from "./actions";

/** Màn 22 — ghép payout với đơn, đánh dấu dòng lệch, ghi tiền về sang Sổ quỹ. */
export default async function ReconcilePage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["ADMIN", "KE_TOAN"]);
  const sp = await searchParams;
  const today = todayVn();
  const [shops, accounts, payouts] = await Promise.all([
    prisma.shop.findMany({ where: { status: { not: "CLOSED" } }, include: { payoutAccount: true }, orderBy: [{ channel: "asc" }, { code: "asc" }] }),
    prisma.cashAccount.findMany({ where: { active: true }, include: { provider: true }, orderBy: [{ provider: { name: "asc" } }, { code: "asc" }] }),
    prisma.payout.findMany({
      include: { shop: true, account: { include: { provider: true } }, lines: { include: { order: { select: { externalId: true } } } } },
      orderBy: [{ periodTo: "desc" }, { createdAt: "desc" }],
      take: 60,
    }),
  ]);

  const view = payouts.map((p) => {
    const res = reconcilePayout(
      { id: p.id, grossUsd: Number(p.grossUsd), feeUsd: Number(p.feeUsd), netUsd: Number(p.netUsd) },
      p.lines.map((l) => ({ orderId: l.orderId, amountUsd: Number(l.amountUsd), kind: l.kind })),
      new Set(p.lines.map((l) => l.orderId).filter((x): x is string => !!x)),
    );
    return { p, res };
  });
  const pending = view.filter((v) => !v.p.cashTxnId).length;

  return (
    <div className="max-w-7xl">
      <PageHead no={22} title="Đối soát payout" />
      <Flash ok={sp.ok} error={sp.error} />
      <p className="mt-2 max-w-3xl text-sm text-ink-2">
        Mỗi lần sàn trả tiền: nhập tổng (gross, phí, net) và dán dòng chi tiết từ báo cáo payout (<code>orderId,amountUsd,kind</code>). Dòng ghép với đơn của shop
        theo mã đơn. Lệch trong {pct(RECONCILE_TOLERANCE)} net được chấp nhận — payout không bao giờ khớp 100% (phí điều chỉnh, hoàn tiền kỳ trước, làm tròn).
        Khi tiền về, bấm “Ghi vào Sổ quỹ” để thành khoản Thu từ shop.
      </p>

      <form action={createPayoutAction} className="card mt-4 p-5">
        <h2 className="font-bold">Thêm payout</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field name="shopId" label="Shop" required empty="Chọn…" options={shops.map((s) => ({ value: s.id, label: `${channelLabel(s.channel)} · ${s.code}${s.payoutAccount ? ` → ${s.payoutAccount.code}` : ""}` }))} />
          <Field name="accountId" label="Tiền về tài khoản" empty="Theo shop" options={accounts.map((a) => ({ value: a.id, label: `${a.provider.name} · ${a.code} (${a.currency})` }))} />
          <Field name="periodFrom" label="Kỳ từ" type="date" required defaultValue={bizDateStr(addDays(today, -14))} />
          <Field name="periodTo" label="Đến" type="date" required defaultValue={bizDateStr(addDays(today, -1))} />
          <Field name="grossUsd" label="Gross (USD)" required inputMode="decimal" />
          <Field name="feeUsd" label="Phí (USD)" inputMode="decimal" />
          <Field name="netUsd" label="Net (USD)" inputMode="decimal" help="Trống = gross − phí" />
          <Field name="arrivedAt" label="Ngày tiền về" type="date" help="Trống nếu chưa về" />
        </div>
        <div className="mt-3">
          <label className="label" htmlFor="lines">Dòng chi tiết (tuỳ chọn)</label>
          <textarea className="input h-28 font-mono text-xs" id="lines" name="lines" placeholder={"orderId,amountUsd,kind\n3412887001,37.33,ORDER\n,-1.20,FEE"} />
        </div>
        <button className="btn-primary mt-4" type="submit">Lưu & đối soát</button>
      </form>

      <section className="mt-6">
        <h2 className="font-bold">Payout {pending > 0 && <span className="text-sm font-normal text-ink-2">· {pending} chưa ghi vào Sổ quỹ</span>}</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl text-sm">
            <thead>
              <tr><th>Shop</th><th>Kỳ</th><th>Tài khoản</th><th className="text-right">Gross</th><th className="text-right">Phí</th><th className="text-right">Net</th><th>Đối soát</th><th>Sổ quỹ</th></tr>
            </thead>
            <tbody>
              {view.map(({ p, res }) => {
                const unmatched = p.lines.filter((l) => !l.orderId && l.kind === "ORDER");
                const s = PAYOUT_SCHEDULE[p.channel as Channel];
                return (
                  <tr key={p.id} className="align-top">
                    <td className="whitespace-nowrap">{p.shop?.code ?? "—"} <span className="text-xs text-muted">{channelLabel(p.channel)}</span></td>
                    <td className="whitespace-nowrap tabular-nums">
                      {fmtBizDate(p.periodFrom)} – {fmtBizDate(p.periodTo)}
                      {s && <div className="text-xs text-muted">chu kỳ {s.everyDays} ngày, trễ {s.lagDays}</div>}
                    </td>
                    <td className="whitespace-nowrap">{p.account.provider.name} · {p.account.code}</td>
                    <td className="text-right tabular-nums">{usd(Number(p.grossUsd))}</td>
                    <td className="text-right tabular-nums">{usd(Number(p.feeUsd))}</td>
                    <td className="text-right font-semibold tabular-nums">{usd(Number(p.netUsd))}</td>
                    <td className="min-w-[220px]">
                      {!p.lines.length ? (
                        <Badge>Chưa có dòng</Badge>
                      ) : res.withinTolerance ? (
                        <Badge tone="good">✓ {res.balanced ? "Khớp" : `Lệch ${usd(res.diffUsd)} (trong ngưỡng)`}</Badge>
                      ) : (
                        <Badge tone="crit">⚠ Lệch {usd(res.diffUsd)}</Badge>
                      )}
                      {p.lines.length > 0 && (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-accent">{p.lines.length} dòng · khớp {usd(res.matchedUsd)} · không khớp {usd(res.unmatchedUsd)}</summary>
                          <ul className="mt-1 space-y-0.5">
                            {p.lines.map((l) => (
                              <li key={l.id} className={!l.orderId && l.kind === "ORDER" ? "text-crit" : ""}>
                                {l.kind} {l.externalOrderId ?? ""} {usd(Number(l.amountUsd))} {l.order ? "✓" : l.kind === "ORDER" ? "— không thấy đơn" : ""}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {unmatched.length > 0 && <div className="mt-1 text-xs text-crit">{unmatched.length} dòng đơn chưa có trong hệ thống — import đơn của shop trước</div>}
                    </td>
                    <td className="min-w-[200px]">
                      {p.cashTxnId ? (
                        <Badge tone="good">Đã ghi {p.arrivedAt ? fmtBizDate(p.arrivedAt) : ""}</Badge>
                      ) : (
                        <form action={postPayoutAction.bind(null, p.id)} className="grid gap-1">
                          <input className="input" name="date" type="date" defaultValue={p.arrivedAt ? bizDateStr(p.arrivedAt) : bizDateStr(today)} aria-label="Ngày tiền về" />
                          {p.account.currency === "VND" && <input className="input" name="fxRate" inputMode="decimal" placeholder="Tỷ giá (trống = bảng)" aria-label="Tỷ giá" />}
                          <button className="btn" type="submit">Ghi vào Sổ quỹ</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!view.length && <tr><td colSpan={8} className="py-6 text-center text-muted">Chưa có payout nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
