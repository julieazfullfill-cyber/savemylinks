import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { KIND_LABEL } from "@/lib/cashbook-forms";
import { addDays, bizDateStr, fmtBizDate, fmtTimestamp, parseBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney, type Currency } from "@/lib/money";
import { Badge, Field, Flash, PageHead } from "../ui";
import { createCashTxn, saveFxRate, voidCashTxnAction } from "./actions";

type SP = { acc?: string; from?: string; to?: string; cat?: string; voided?: string; ok?: string; error?: string };

const safeDate = (s: string | undefined, fallback: Date) => {
  try {
    return s ? parseBizDate(s) : fallback;
  } catch {
    return fallback;
  }
};

export default async function CashbookPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireUser(["ADMIN", "KE_TOAN"]);
  const sp = await searchParams;
  const today = todayVn();
  const from = safeDate(sp.from, addDays(today, -30));
  const to = safeDate(sp.to, today);

  // Giữ bộ lọc khi submit form (server action redirect về đúng trang đang xem).
  const keep = new URLSearchParams();
  for (const k of ["acc", "from", "to", "cat", "voided"] as const) if (sp[k]) keep.set(k, sp[k]!);
  const qs = keep.toString();

  const where: Prisma.CashTxnWhereInput = {
    date: { gte: from, lte: to },
    ...(sp.acc ? { accountId: sp.acc } : {}),
    ...(sp.cat ? { categoryId: sp.cat } : {}),
    ...(sp.voided ? {} : { voidedAt: null }),
  };

  const [accounts, categories, suppliers, shops, txns, sums, lastFx, users] = await Promise.all([
    prisma.cashAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.expenseCategory.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.supplier.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.shop.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.cashTxn.findMany({
      where,
      include: { account: true, category: true, journal: { select: { source: true } } },
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

  const totalIn = txns.filter((t) => !t.voidedAt && t.direction === "IN").reduce((a, t) => a + t.amountVnd, 0n);
  const totalOut = txns.filter((t) => !t.voidedAt && t.direction === "OUT").reduce((a, t) => a + t.amountVnd, 0n);

  const accountOpts = accounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name} (${a.currency})` }));

  return (
    <div className="max-w-7xl">
      <PageHead no={2} title="Sổ quỹ" />
      <Flash ok={sp.ok} error={sp.error} />

      {/* Số dư từng tài khoản */}
      <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {accounts.map((a) => {
          const b = balance(a.id);
          return (
            <a key={a.id} href={`/so-quy?acc=${a.id}`} className={`card block p-3 hover:border-accent ${sp.acc === a.id ? "border-accent" : ""}`}>
              <div className="truncate text-xs text-muted">{a.code} · {a.name}</div>
              <div className={`mt-0.5 font-bold tabular-nums ${b < 0n ? "text-crit" : ""}`}>{formatMoney(b, a.currency as Currency)}</div>
            </a>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-muted">
        Số dư tính từ sổ quỹ (giao dịch chưa huỷ). Nhập “Số dư đầu kỳ” cho từng tài khoản trước khi nhập giao dịch thường.
      </p>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_280px]">
        {/* Nhập nhanh */}
        <form action={createCashTxn.bind(null, qs)} className="card p-5">
          <h2 className="font-bold">Nhập giao dịch</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field name="kind" label="Loại" required empty={false} defaultValue="OUT" options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />
            <Field name="date" label="Ngày" type="date" required defaultValue={bizDateStr(today)} />
            <Field name="accountId" label="Tài khoản tiền" required empty="Chọn…" defaultValue={sp.acc} options={accountOpts} />
            <Field name="amount" label="Số tiền" required inputMode="decimal" placeholder="1.250.000 hoặc 125,50" help="Theo tiền của tài khoản (đồng / đô)" />
            <Field name="categoryId" label="Hạng mục" options={categories.map((c) => ({ value: c.id, label: c.name }))} help="Để trống: thu khác (409) / chi khác (699)" />
            <Field name="supplierId" label="Nhà cung cấp" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
            <Field name="shopId" label="Shop" options={shops.map((s) => ({ value: s.id, label: s.name }))} />
            <Field name="fxRate" label="Tỷ giá (USD)" inputMode="decimal" placeholder={lastFx ? lastFx.rate.toString() : "25.400"} help="Trống = tỷ giá gần nhất trong bảng" />
          </div>
          <div className="mt-4"><Field name="description" label="Diễn giải" required placeholder="Nạp Merchize đơn tuần 45…" /></div>
          <div className="mt-5"><button className="btn-primary" type="submit">Ghi sổ</button></div>
        </form>

        {/* Tỷ giá */}
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

      {/* Lọc */}
      <form method="get" className="card mt-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <Field name="acc" label="Tài khoản" empty="Tất cả" defaultValue={sp.acc} options={accountOpts} />
        <Field name="from" label="Từ ngày" type="date" defaultValue={bizDateStr(from)} />
        <Field name="to" label="Đến ngày" type="date" defaultValue={bizDateStr(to)} />
        <Field name="cat" label="Hạng mục" empty="Tất cả" defaultValue={sp.cat} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" name="voided" value="1" defaultChecked={!!sp.voided} /> Hiện cả giao dịch đã huỷ
        </label>
        <div className="flex items-end gap-2">
          <button className="btn-primary" type="submit">Lọc</button>
          <a className="btn" href="/so-quy">Xoá lọc</a>
        </div>
      </form>

      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <span>{txns.length} giao dịch</span>
        <span>Thu: <strong className="tabular-nums text-good">{formatMoney(totalIn)}</strong></span>
        <span>Chi: <strong className="tabular-nums text-crit">{formatMoney(totalOut)}</strong></span>
        <span className="text-muted">(quy VND theo tỷ giá ngày giao dịch)</span>
      </div>

      <div className="card mt-2 overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Ngày</th><th>Tài khoản</th><th>Loại</th><th className="text-right">Số tiền</th>
              <th className="text-right">Quy VND</th><th>Hạng mục</th><th>Diễn giải</th><th>Người ghi</th><th />
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => {
              const kind = t.journal?.source === "OPENING" ? "OPENING" : t.direction;
              return (
                <tr key={t.id} className={t.voidedAt ? "opacity-50" : ""}>
                  <td className="whitespace-nowrap tabular-nums">{fmtBizDate(t.date)}</td>
                  <td className="whitespace-nowrap">{t.account.code}</td>
                  <td>
                    <Badge tone={kind === "OUT" ? "crit" : kind === "OPENING" ? "accent" : "good"}>{KIND_LABEL[kind]}</Badge>
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">{formatMoney(t.amount, t.currency as Currency)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {formatMoney(t.amountVnd)}
                    {t.currency !== "VND" && <div className="text-xs text-muted">@{Number(t.fxRate).toLocaleString("vi-VN")}</div>}
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
            {!txns.length && (
              <tr><td colSpan={9} className="py-8 text-center text-muted">Chưa có giao dịch trong khoảng ngày này.</td></tr>
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
