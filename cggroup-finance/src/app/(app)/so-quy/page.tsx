import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { KIND_LABEL, txnKind } from "@/lib/cashbook-forms";
import { channelLabel, CHANNELS } from "@/lib/channels";
import { addDays, bizDateStr, fmtBizDate, fmtTimestamp, parseBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney, type Currency } from "@/lib/money";
import { Badge, Field, Flash, PageHead } from "../ui";
import { createCashTxn, saveFxRate, voidCashTxnAction } from "./actions";
import { EntryForm } from "./entry-form";

type SP = { prov?: string; acc?: string; from?: string; to?: string; cat?: string; ch?: string; shop?: string; voided?: string; ok?: string; error?: string };

const safeDate = (s: string | undefined, fallback: Date) => {
  try {
    return s ? parseBizDate(s) : fallback;
  } catch {
    return fallback;
  }
};

const KIND_TONE = { OUT: "crit", SHOP_IN: "good", IN: "good", OPENING: "accent" } as const;

export default async function CashbookPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireUser(["ADMIN", "KE_TOAN"]);
  const sp = await searchParams;
  const today = todayVn();
  const from = safeDate(sp.from, addDays(today, -30));
  const to = safeDate(sp.to, today);

  // Giữ bộ lọc khi submit form (server action redirect về đúng trang đang xem).
  const keep = new URLSearchParams();
  for (const k of ["prov", "acc", "from", "to", "cat", "ch", "shop", "voided"] as const) if (sp[k]) keep.set(k, sp[k]!);
  const qs = keep.toString();

  const shops = await prisma.shop.findMany({ orderBy: [{ channel: "asc" }, { code: "asc" }] });
  const shopById = new Map(shops.map((s) => [s.id, s]));
  const channelShopIds = sp.ch ? shops.filter((s) => s.channel === sp.ch).map((s) => s.id) : null;

  const where: Prisma.CashTxnWhereInput = {
    date: { gte: from, lte: to },
    ...(sp.acc ? { accountId: sp.acc } : sp.prov ? { account: { providerId: sp.prov } } : {}),
    ...(sp.cat ? { categoryId: sp.cat } : {}),
    ...(sp.shop ? { shopId: sp.shop } : channelShopIds ? { shopId: { in: channelShopIds } } : {}),
    ...(sp.voided ? {} : { voidedAt: null }),
  };

  const [accounts, categories, suppliers, txns, sums, lastFx, users] = await Promise.all([
    prisma.cashAccount.findMany({
      where: { active: true },
      include: { provider: true },
      orderBy: [{ provider: { name: "asc" } }, { code: "asc" }],
    }),
    prisma.expenseCategory.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.supplier.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.cashTxn.findMany({
      where,
      include: { account: { include: { provider: true } }, category: true, journal: { select: { source: true } } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 300,
    }),
    // Số dư = tổng giao dịch chưa huỷ, theo nguyên tệ của tài khoản.
    prisma.cashTxn.groupBy({ by: ["accountId", "direction"], where: { voidedAt: null }, _sum: { amount: true } }),
    prisma.fxRate.findFirst({ where: { base: "USD", quote: "VND" }, orderBy: { date: "desc" } }),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const balance = (id: string) =>
    sums.filter((s) => s.accountId === id).reduce((a, s) => a + (s.direction === "IN" ? 1n : -1n) * (s._sum.amount ?? 0n), 0n);

  const rows = txns.map((t) => ({ ...t, kind: txnKind({ ...t, journalSource: t.journal?.source }) }));
  const live = rows.filter((t) => !t.voidedAt);
  const totalIn = live.filter((t) => t.direction === "IN" && t.kind !== "OPENING").reduce((a, t) => a + t.amountVnd, 0n);
  const totalOut = live.filter((t) => t.direction === "OUT").reduce((a, t) => a + t.amountVnd, 0n);

  // Tổng thu từ shop theo kênh → shop, trong khoảng lọc.
  const shopIncome = new Map<string, bigint>();
  for (const t of live) if (t.kind === "SHOP_IN") shopIncome.set(t.shopId!, (shopIncome.get(t.shopId!) ?? 0n) + t.amountVnd);
  const byChannel = CHANNELS.map((c) => {
    const list = shops
      .filter((s) => s.channel === c.code)
      .map((s) => ({ shop: s, vnd: shopIncome.get(s.id) ?? 0n }))
      .sort((a, b) => (b.vnd > a.vnd ? 1 : b.vnd < a.vnd ? -1 : 0));
    return { ...c, list, vnd: list.reduce((a, x) => a + x.vnd, 0n) };
  });
  const shopIncomeTotal = byChannel.reduce((a, c) => a + c.vnd, 0n);

  const accountOpts = accounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.email ?? a.name} (${a.currency})`, group: a.provider.name }));
  // Mọi nhóm đang dùng, kể cả nhóm chưa có tài khoản (để thấy chỗ thêm).
  const providers = await prisma.cashProvider.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  const channelOpts = CHANNELS.map((c) => ({ value: c.code, label: c.label }));
  const filterLink = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ from: bizDateStr(from), to: bizDateStr(to), ...extra });
    return `/so-quy?${p}`;
  };

  return (
    <div className="max-w-7xl">
      <PageHead no={2} title="Sổ quỹ" />
      <Flash ok={sp.ok} error={sp.error} />

      {/* Số dư theo nhóm (Payoneer, Airwallex…) → từng tài khoản/email */}
      <div className="mt-5 flex items-baseline justify-between">
        <h2 className="font-bold">Số dư tài khoản tiền</h2>
        <span className="text-xs">
          <Link className="text-accent hover:underline" href="/danh-muc/nhom-tai-khoan-tien?edit=new">+ Nhóm</Link>
          {" · "}
          <Link className="text-accent hover:underline" href="/danh-muc/tai-khoan-tien?edit=new">+ Tài khoản</Link>
        </span>
      </div>
      <div className="mt-2 space-y-3">
        {providers.map((p) => {
          const list = accounts.filter((a) => a.providerId === p.id);
          const subtotal = new Map<Currency, bigint>();
          for (const a of list) subtotal.set(a.currency as Currency, (subtotal.get(a.currency as Currency) ?? 0n) + balance(a.id));
          return (
            <div key={p.id} className={`card p-3 ${sp.prov === p.id ? "border-accent" : ""}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link className="font-semibold hover:text-accent" href={`/so-quy?prov=${p.id}`}>{p.name}</Link>
                <span className="text-sm tabular-nums">
                  {[...subtotal].map(([cur, v], i) => (
                    <span key={cur} className={v < 0n ? "text-crit" : ""}>{i > 0 && " · "}{formatMoney(v, cur)}</span>
                  ))}
                </span>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {list.map((a) => {
                  const b = balance(a.id);
                  return (
                    <Link
                      key={a.id}
                      href={`/so-quy?acc=${a.id}`}
                      className={`block rounded-md border px-3 py-2 hover:border-accent ${sp.acc === a.id ? "border-accent" : "border-hair"}`}
                    >
                      <div className="truncate text-xs text-muted" title={a.email ?? a.name}>{a.code} · {a.email ?? a.name}</div>
                      <div className={`font-bold tabular-nums ${b < 0n ? "text-crit" : ""}`}>{formatMoney(b, a.currency as Currency)}</div>
                    </Link>
                  );
                })}
                {!list.length && (
                  <Link className="rounded-md border border-dashed border-hair px-3 py-2 text-sm text-accent hover:border-accent" href="/danh-muc/tai-khoan-tien?edit=new">
                    + Thêm tài khoản {p.name}
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-muted">
        Số dư tính từ sổ quỹ (giao dịch chưa huỷ). Nhập “Số dư đầu kỳ” cho từng tài khoản trước khi nhập giao dịch thường.
      </p>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_280px]">
        <EntryForm
          action={createCashTxn.bind(null, qs)}
          accounts={accountOpts}
          categories={categories.map((c) => ({ value: c.id, label: c.name }))}
          suppliers={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          shops={shops.filter((s) => s.status !== "CLOSED").map((s) => ({ id: s.id, code: s.code, name: s.name, channel: s.channel }))}
          channels={channelOpts}
          today={bizDateStr(today)}
          defaultAccount={sp.acc}
          fxPlaceholder={lastFx ? lastFx.rate.toString() : "25.400"}
        />

        <form action={saveFxRate.bind(null, qs)} className="card p-5">
          <h2 className="font-bold">Tỷ giá USD/VND</h2>
          <p className="mt-1 text-sm text-ink-2">
            Gần nhất:{" "}
            {lastFx ? (
              <strong className="tabular-nums">{Number(lastFx.rate).toLocaleString("vi-VN")} · {fmtBizDate(lastFx.date)}</strong>
            ) : (
              <span className="text-crit">chưa có — giao dịch USD sẽ báo lỗi</span>
            )}
          </p>
          <div className="mt-3 space-y-3">
            <Field name="date" label="Ngày" type="date" required defaultValue={bizDateStr(today)} />
            <Field name="rate" label="Tỷ giá" required inputMode="decimal" placeholder="25.400" />
          </div>
          <button className="btn mt-4" type="submit">Lưu tỷ giá</button>
        </form>
      </div>

      {/* Thu theo kênh → shop */}
      <section className="card mt-5 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-bold">Thu từ shop theo kênh</h2>
          <span className="text-sm text-muted">
            {fmtBizDate(from)} – {fmtBizDate(to)} · tổng <strong className="tabular-nums text-ink">{formatMoney(shopIncomeTotal)}</strong>
          </span>
        </div>
        {shops.length === 0 ? (
          <p className="mt-3 text-sm text-ink-2">
            Chưa có shop nào.{" "}
            <Link className="text-accent hover:underline" href="/danh-muc/shop?edit=new">Tạo shop</Link> và chọn kênh (Amazon, Etsy, Walmart, TikTok, Website) để bắt đầu ghi tiền thu theo shop.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {byChannel.map((c) => (
              <div key={c.code} className={`rounded-md border p-3 ${sp.ch === c.code ? "border-accent" : "border-hair"}`}>
                <a className="flex items-baseline justify-between hover:text-accent" href={filterLink({ ch: c.code })}>
                  <span className="font-semibold">{c.label}</span>
                  <span className="text-xs text-muted">TK {c.revenueAccount}</span>
                </a>
                <div className="font-bold tabular-nums">{formatMoney(c.vnd)}</div>
                <ul className="mt-2 space-y-0.5 text-xs">
                  {c.list.map(({ shop, vnd }) => (
                    <li key={shop.id} className="flex justify-between gap-2">
                      <a className={`truncate hover:text-accent ${shop.status !== "ACTIVE" ? "text-muted" : ""}`} href={filterLink({ shop: shop.id })}>
                        {shop.code}
                      </a>
                      <span className="tabular-nums">{vnd ? formatMoney(vnd) : <span className="text-muted">—</span>}</span>
                    </li>
                  ))}
                  {!c.list.length && <li className="text-muted">Chưa có shop</li>}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Lọc */}
      <form method="get" className="card mt-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field name="prov" label="Nhóm tài khoản" empty="Tất cả" defaultValue={sp.prov} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
        <Field name="acc" label="Tài khoản" empty="Tất cả" defaultValue={sp.acc} options={accountOpts.map((a) => ({ value: a.value, label: `${a.group} · ${a.label}` }))} />
        <Field name="from" label="Từ ngày" type="date" defaultValue={bizDateStr(from)} />
        <Field name="to" label="Đến ngày" type="date" defaultValue={bizDateStr(to)} />
        <Field name="cat" label="Hạng mục" empty="Tất cả" defaultValue={sp.cat} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        <Field name="ch" label="Kênh" empty="Tất cả" defaultValue={sp.ch} options={channelOpts} />
        <Field
          name="shop"
          label="Shop"
          empty="Tất cả"
          defaultValue={sp.shop}
          options={shops.map((s) => ({ value: s.id, label: `${channelLabel(s.channel)} · ${s.code}` }))}
        />
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" name="voided" value="1" defaultChecked={!!sp.voided} /> Hiện cả giao dịch đã huỷ
        </label>
        <div className="flex items-end gap-2">
          <button className="btn-primary" type="submit">Lọc</button>
          <a className="btn" href="/so-quy">Xoá lọc</a>
        </div>
      </form>

      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <span>{rows.length} giao dịch</span>
        <span>Thu: <strong className="tabular-nums text-good">{formatMoney(totalIn)}</strong></span>
        <span>Chi: <strong className="tabular-nums text-crit">{formatMoney(totalOut)}</strong></span>
        <span className="text-muted">(quy VND theo tỷ giá ngày giao dịch, không tính số dư đầu kỳ)</span>
      </div>

      <div className="card mt-2 overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Ngày</th><th>Tài khoản</th><th>Loại</th><th className="text-right">Số tiền</th>
              <th className="text-right">Quy VND</th><th>Kênh · Shop</th><th>Hạng mục</th><th>Diễn giải</th><th>Người ghi</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const shop = t.shopId ? shopById.get(t.shopId) : undefined;
              return (
                <tr key={t.id} className={t.voidedAt ? "opacity-50" : ""}>
                  <td className="whitespace-nowrap tabular-nums">{fmtBizDate(t.date)}</td>
                  <td className="whitespace-nowrap">
                    <span className="text-xs text-muted">{t.account.provider.name} · </span>
                    {t.account.code}
                  </td>
                  <td><Badge tone={KIND_TONE[t.kind]}>{KIND_LABEL[t.kind]}</Badge></td>
                  <td className="whitespace-nowrap text-right tabular-nums">{formatMoney(t.amount, t.currency as Currency)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {formatMoney(t.amountVnd)}
                    {t.currency !== "VND" && <div className="text-xs text-muted">@{Number(t.fxRate).toLocaleString("vi-VN")}</div>}
                  </td>
                  <td className="whitespace-nowrap">
                    {shop ? (
                      <>
                        <span className="text-xs text-muted">{channelLabel(shop.channel)} · </span>
                        {shop.code}
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td>{t.category?.name ?? <span className="text-muted">—</span>}</td>
                  <td className="min-w-[200px]">
                    {t.description}
                    {t.supplierId && <div className="text-xs text-muted">NCC: {supplierName.get(t.supplierId) ?? t.supplierId}</div>}
                    {t.voidedAt && (
                      <div className="text-xs text-crit">
                        Đã huỷ {fmtTimestamp(t.voidedAt)} bởi {userName.get(t.voidedBy ?? "") ?? t.voidedBy}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-xs text-muted">{userName.get(t.createdBy) ?? t.createdBy}</td>
                  <td>
                    {!t.voidedAt && (
                      <details>
                        <summary className="cursor-pointer text-xs text-crit">Huỷ</summary>
                        <form action={voidCashTxnAction.bind(null, qs, t.id)} className="mt-2 flex w-56 gap-1">
                          <input className="input" name="reason" required placeholder="Lý do huỷ" />
                          <button className="btn" type="submit">OK</button>
                        </form>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={10} className="py-8 text-center text-muted">Chưa có giao dịch trong khoảng ngày này.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Không xoá được giao dịch: huỷ sẽ ghi bút toán ngược, giữ nguyên dấu vết. Sửa = huỷ rồi nhập lại.
      </p>
    </div>
  );
}
