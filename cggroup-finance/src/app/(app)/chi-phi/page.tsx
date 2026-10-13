import type { ExpenseStatus, Prisma } from "@prisma/client";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { bizDateStr, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { monthlySpendByCategory } from "@/lib/expenses";
import { formatMoney, type Currency } from "@/lib/money";
import { Badge, Field, Flash, PageHead } from "../ui";
import { approveAction, createExpenseAction, payAction, rejectAction } from "./actions";

const TABS: { key: ExpenseStatus; label: string }[] = [
  { key: "DRAFT", label: "Chờ duyệt" },
  { key: "APPROVED", label: "Đã duyệt, chờ chi" },
  { key: "PAID", label: "Đã chi" },
  { key: "REJECTED", label: "Từ chối" },
];

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ tab?: string; ok?: string; error?: string }> }) {
  const me = await requireUser();
  const sp = await searchParams;
  const tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "DRAFT") as ExpenseStatus;
  const canApprove = me.role === "ADMIN" || me.role === "QUAN_LY";
  const canPay = me.role === "ADMIN" || me.role === "KE_TOAN";
  // Nhân viên chỉ thấy đề nghị của mình.
  const mine: Prisma.ExpenseWhereInput = me.role === "NHAN_VIEN" ? { requestedBy: me.uid } : {};
  const today = todayVn();

  const [categories, suppliers, accounts, users, list, counts, spend] = await Promise.all([
    prisma.expenseCategory.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.supplier.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.cashAccount.findMany({ where: { active: true }, include: { provider: true }, orderBy: [{ provider: { name: "asc" } }, { code: "asc" }] }),
    prisma.user.findMany({ select: { id: true, name: true } }),
    prisma.expense.findMany({ where: { ...mine, status: tab }, include: { category: true }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 200 }),
    prisma.expense.groupBy({ by: ["status"], where: mine, _count: true }),
    prisma.$transaction((tx) => monthlySpendByCategory(tx, today.getUTCFullYear(), today.getUTCMonth() + 1)),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const count = (s: ExpenseStatus) => counts.find((c) => c.status === s)?._count ?? 0;
  const budgeted = categories.filter((c) => c.budgetVnd);

  return (
    <div className="max-w-7xl">
      <PageHead no={3} title="Chi phí & duyệt chi" />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_340px]">
        <form action={createExpenseAction} className="card p-5">
          <h2 className="font-bold">Đề nghị chi</h2>
          <p className="mt-1 text-sm text-muted">Khoản đã phát sinh cần duyệt. Chi ngay không cần duyệt thì nhập thẳng ở Sổ quỹ.</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field name="date" label="Ngày phát sinh" type="date" required defaultValue={bizDateStr(today)} />
            <Field name="categoryId" label="Hạng mục" required empty="Chọn…" options={categories.map((c) => ({ value: c.id, label: c.name }))} />
            <Field name="supplierId" label="Nhà cung cấp" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
            <Field name="amount" label="Số tiền" required inputMode="decimal" placeholder="2.500.000" />
            <Field name="currency" label="Loại tiền" empty={false} defaultValue="VND" options={[{ value: "VND", label: "VND" }, { value: "USD", label: "USD" }]} />
            <Field name="fxRate" label="Tỷ giá (USD)" inputMode="decimal" help="Trống = tỷ giá gần nhất" />
          </div>
          <div className="mt-4"><Field name="description" label="Diễn giải" required placeholder="Gia hạn VPS tháng 11…" /></div>
          <button className="btn-primary mt-5" type="submit">Gửi đề nghị</button>
        </form>

        <section className="card p-5">
          <h2 className="font-bold">Ngân sách tháng {today.getUTCMonth() + 1}</h2>
          {budgeted.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              Chưa hạng mục nào có ngân sách.{" "}
              {me.role === "ADMIN" && <Link className="text-accent hover:underline" href="/danh-muc/hang-muc-chi-phi">Đặt ngân sách</Link>}
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {budgeted.map((c) => {
                const used = spend.get(c.id) ?? 0n;
                const pct = Number((used * 1000n) / c.budgetVnd!) / 10;
                const over = used > c.budgetVnd!;
                return (
                  <li key={c.id} className="text-sm">
                    <div className="flex justify-between gap-2">
                      <span>{c.name}</span>
                      <span className={over ? "font-semibold text-crit" : "text-ink-2"}>{over && "⚠ "}{pct.toLocaleString("vi-VN")}%</span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-accent/15" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${c.name} đã dùng`}>
                      <div className={`h-2 rounded-full ${over ? "bg-crit" : "bg-accent"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                    <div className="mt-0.5 text-xs text-muted">{formatMoney(used)} / {formatMoney(c.budgetVnd!)}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="mt-6 flex gap-1 overflow-x-auto border-b border-hair">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/chi-phi?tab=${t.key}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${t.key === tab ? "border-accent font-semibold text-accent" : "border-transparent text-ink-2 hover:text-ink"}`}
          >
            {t.label} <span className="text-xs text-muted">({count(t.key)})</span>
          </Link>
        ))}
      </div>

      <div className="card mt-3 overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Ngày</th><th>Hạng mục</th><th>Diễn giải</th><th className="text-right">Số tiền</th><th>Người đề nghị</th>
              <th>{tab === "DRAFT" ? "" : tab === "REJECTED" ? "Lý do" : "Duyệt"}</th><th />
            </tr>
          </thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id}>
                <td className="tabular-nums">{fmtBizDate(e.date)}</td>
                <td>{e.category.name}</td>
                <td className="min-w-[220px]">
                  {e.description}
                  {e.supplierId && <div className="text-xs text-muted">NCC: {supplierName.get(e.supplierId)}</div>}
                </td>
                <td className="whitespace-nowrap text-right tabular-nums">
                  {formatMoney(e.amount, e.currency as Currency)}
                  {e.currency !== "VND" && <div className="text-xs text-muted">{formatMoney(e.amountVnd)}</div>}
                </td>
                <td className="whitespace-nowrap">{userName.get(e.requestedBy) ?? e.requestedBy}</td>
                <td className="text-xs text-ink-2">
                  {tab === "REJECTED" ? e.rejectedReason : e.approvedBy ? `${userName.get(e.approvedBy) ?? e.approvedBy} · ${e.approvedAt ? fmtBizDate(e.approvedAt) : ""}` : ""}
                </td>
                <td className="whitespace-nowrap">
                  {tab === "DRAFT" && canApprove && (
                    <div className="flex items-start gap-2">
                      <form action={approveAction.bind(null, e.id)}><button className="btn-primary" type="submit">Duyệt</button></form>
                      <details>
                        <summary className="cursor-pointer pt-1.5 text-sm text-crit">Từ chối</summary>
                        <form action={rejectAction.bind(null, e.id)} className="mt-2 flex w-60 gap-1">
                          <input className="input" name="reason" required placeholder="Lý do" />
                          <button className="btn" type="submit">OK</button>
                        </form>
                      </details>
                    </div>
                  )}
                  {tab === "APPROVED" && canPay && (
                    <details>
                      <summary className="cursor-pointer text-sm text-accent">Chi tiền</summary>
                      <form action={payAction.bind(null, e.id)} className="mt-2 grid w-64 gap-2">
                        <select className="input" name="accountId" required defaultValue="">
                          <option value="">Chi từ tài khoản…</option>
                          {accounts.map((a) => <option key={a.id} value={a.id}>{a.provider.name} · {a.code} ({a.currency})</option>)}
                        </select>
                        <input className="input" name="date" type="date" required defaultValue={bizDateStr(today)} aria-label="Ngày chi" />
                        <input className="input" name="amount" inputMode="decimal" placeholder="Số thực chi (trống = đúng đề nghị)" aria-label="Số tiền" />
                        <input className="input" name="fxRate" inputMode="decimal" placeholder="Tỷ giá (nếu chi USD)" aria-label="Tỷ giá" />
                        <button className="btn-primary" type="submit">Ghi chi</button>
                      </form>
                    </details>
                  )}
                  {tab === "PAID" && e.cashTxnId && <Badge tone="good">Đã vào Sổ quỹ</Badge>}
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={7} className="py-8 text-center text-muted">Không có đề nghị nào.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
