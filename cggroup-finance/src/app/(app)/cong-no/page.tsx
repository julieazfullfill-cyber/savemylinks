import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { addDays, bizDateStr, daysBetween, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney, type Currency } from "@/lib/money";
import { AGING_LABEL, agingBucket, type AgingBucket } from "@/lib/payables";
import { Badge, Field, Flash, PageHead } from "../ui";
import { createBillAction, payBillAction } from "./actions";

type SP = { sup?: string; st?: string; soon?: string; ok?: string; error?: string };
const STATUS_LABEL = { OPEN: "Chưa trả", PARTIAL: "Trả một phần", PAID: "Đã trả" } as const;
const BUCKET_TONE: Record<AgingBucket, "muted" | "accent" | "crit"> = {
  NOT_DUE: "muted",
  D1_30: "accent",
  D31_60: "crit",
  D61_90: "crit",
  D90_PLUS: "crit",
};

export default async function PayablesPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireUser(["ADMIN", "KE_TOAN"]);
  const sp = await searchParams;
  const today = todayVn();
  const st = sp.st ?? "OWED";

  const keep = new URLSearchParams();
  for (const k of ["sup", "st", "soon"] as const) if (sp[k]) keep.set(k, sp[k]!);
  const qs = keep.toString();

  const where: Prisma.SupplierBillWhereInput = {
    ...(sp.sup ? { supplierId: sp.sup } : {}),
    ...(st === "OWED" ? { status: { in: ["OPEN", "PARTIAL"] } } : st === "ALL" ? {} : { status: st }),
    ...(sp.soon ? { dueDate: { lte: addDays(today, 7) }, status: { in: ["OPEN", "PARTIAL"] } } : {}),
  };

  const [suppliers, bills, owed, accounts, expenseAccounts] = await Promise.all([
    prisma.supplier.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.supplierBill.findMany({ where, include: { supplier: true, _count: { select: { payments: true } } }, orderBy: [{ dueDate: "asc" }], take: 300 }),
    prisma.supplierBill.findMany({ where: { status: { in: ["OPEN", "PARTIAL"] } }, select: { dueDate: true, amountVnd: true, paidVnd: true } }),
    prisma.cashAccount.findMany({ where: { active: true }, include: { provider: true }, orderBy: [{ provider: { name: "asc" } }, { code: "asc" }] }),
    prisma.account.findMany({ where: { type: { in: ["COGS", "EXPENSE"] } }, orderBy: { code: "asc" } }),
  ]);

  const buckets = new Map<AgingBucket, bigint>();
  for (const b of owed) {
    const k = agingBucket(b.dueDate, today);
    buckets.set(k, (buckets.get(k) ?? 0n) + b.amountVnd - b.paidVnd);
  }
  const totalOwed = [...buckets.values()].reduce((a, v) => a + v, 0n);
  const accountOpts = accounts.map((a) => ({ value: a.id, label: `${a.provider.name} · ${a.code} (${a.currency})` }));

  return (
    <div className="max-w-7xl">
      <PageHead no={4} title="Công nợ nhà cung cấp" />
      <Flash ok={sp.ok} error={sp.error} />

      {/* Tuổi nợ */}
      <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="card p-4">
          <div className="text-xs text-ink-2">Tổng còn nợ</div>
          <div className="mt-1 text-lg font-bold">{formatMoney(totalOwed)}</div>
        </div>
        {(Object.keys(AGING_LABEL) as AgingBucket[]).map((k) => (
          <div key={k} className="card p-4">
            <div className="text-xs text-ink-2">{AGING_LABEL[k]}</div>
            <div className={`mt-1 text-lg font-semibold ${k !== "NOT_DUE" && (buckets.get(k) ?? 0n) > 0n ? "text-crit" : ""}`}>
              {formatMoney(buckets.get(k) ?? 0n)}
            </div>
          </div>
        ))}
      </div>

      {/* Nhận hoá đơn */}
      <form action={createBillAction.bind(null, qs)} className="card mt-5 p-5">
        <h2 className="font-bold">Ghi nhận hoá đơn NCC</h2>
        <p className="mt-1 text-sm text-muted">Bút toán: Nợ TK chi phí / Có 201 Phải trả. Hạn trả để trống = ngày hoá đơn + số ngày công nợ của NCC.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field name="supplierId" label="Nhà cung cấp" required empty="Chọn…" options={suppliers.map((s) => ({ value: s.id, label: `${s.name}${s.prepaid ? " (trả trước)" : ` (công nợ ${s.creditDays} ngày)`}` }))} />
          <Field name="billNo" label="Số hoá đơn" />
          <Field name="issueDate" label="Ngày hoá đơn" type="date" required defaultValue={bizDateStr(today)} />
          <Field name="dueDate" label="Hạn trả" type="date" help="Trống = theo công nợ NCC" />
          <Field name="amount" label="Số tiền" required inputMode="decimal" placeholder="12.500.000 hoặc 1.250,50" />
          <Field name="currency" label="Loại tiền" required empty={false} defaultValue="USD" options={[{ value: "USD", label: "USD" }, { value: "VND", label: "VND" }]} />
          <Field name="fxRate" label="Tỷ giá (USD)" inputMode="decimal" help="Trống = tỷ giá gần nhất ngày hoá đơn" />
          <Field name="accountCode" label="TK chi phí" empty={false} defaultValue="501" options={expenseAccounts.map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` }))} />
        </div>
        <div className="mt-4"><Field name="description" label="Diễn giải" placeholder="Đơn fulfill tuần 45…" /></div>
        <button className="btn-primary mt-5" type="submit">Ghi nhận</button>
      </form>

      {/* Lọc */}
      <form method="get" className="card mt-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field name="sup" label="Nhà cung cấp" empty="Tất cả" defaultValue={sp.sup} options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
        <Field name="st" label="Trạng thái" empty={false} defaultValue={st} options={[{ value: "OWED", label: "Còn nợ" }, { value: "PAID", label: "Đã trả" }, { value: "ALL", label: "Tất cả" }]} />
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" name="soon" value="1" defaultChecked={!!sp.soon} /> Chỉ hoá đơn quá hạn / đến hạn trong 7 ngày
        </label>
        <div className="flex items-end gap-2">
          <button className="btn-primary" type="submit">Lọc</button>
          <a className="btn" href="/cong-no">Xoá lọc</a>
        </div>
      </form>

      <div className="card mt-3 overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>NCC</th><th>Số HĐ</th><th>Ngày HĐ</th><th>Hạn trả</th><th>Tuổi nợ</th>
              <th className="text-right">Số tiền</th><th className="text-right">Đã trả</th><th className="text-right">Còn nợ</th><th>Trạng thái</th><th />
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => {
              const remain = b.amountVnd - b.paidVnd;
              const bucket = agingBucket(b.dueDate, today);
              const late = daysBetween(b.dueDate, today);
              return (
                <tr key={b.id}>
                  <td className="whitespace-nowrap">{b.supplier.name}</td>
                  <td>{b.billNo ?? <span className="text-muted">—</span>}{b.description && <div className="text-xs text-muted">{b.description}</div>}</td>
                  <td className="tabular-nums">{fmtBizDate(b.issueDate)}</td>
                  <td className="tabular-nums">{fmtBizDate(b.dueDate)}</td>
                  <td>
                    {b.status === "PAID" ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <Badge tone={BUCKET_TONE[bucket]}>{bucket === "NOT_DUE" ? (late > -8 ? `còn ${-late} ngày` : "chưa đến hạn") : `quá ${late} ngày`}</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {formatMoney(b.amount, b.currency as Currency)}
                    {b.currency !== "VND" && <div className="text-xs text-muted">{formatMoney(b.amountVnd)}</div>}
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">{formatMoney(b.paidVnd)}{b._count.payments > 0 && <div className="text-xs text-muted">{b._count.payments} lần</div>}</td>
                  <td className="whitespace-nowrap text-right font-semibold tabular-nums">{formatMoney(remain)}</td>
                  <td><Badge tone={b.status === "PAID" ? "good" : b.status === "PARTIAL" ? "accent" : "muted"}>{STATUS_LABEL[b.status as keyof typeof STATUS_LABEL]}</Badge></td>
                  <td>
                    {b.status !== "PAID" && (
                      <details>
                        <summary className="cursor-pointer text-sm text-accent">Trả tiền</summary>
                        <form action={payBillAction.bind(null, qs, b.id)} className="mt-2 grid w-72 gap-2">
                          <select className="input" name="accountId" required defaultValue="">
                            <option value="">Trả từ tài khoản…</option>
                            {accountOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          <input className="input" name="date" type="date" required defaultValue={bizDateStr(today)} aria-label="Ngày trả" />
                          <input className="input" name="amount" required inputMode="decimal" placeholder="Số tiền theo tiền tài khoản" aria-label="Số tiền trả" />
                          <input className="input" name="fxRate" inputMode="decimal" placeholder="Tỷ giá (nếu trả bằng USD)" aria-label="Tỷ giá" />
                          <label className="flex items-center gap-2 text-xs">
                            <input type="checkbox" name="settle" /> Tất toán (chênh tỷ giá vào 701)
                          </label>
                          <button className="btn-primary" type="submit">Ghi thanh toán</button>
                        </form>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
            {!bills.length && <tr><td colSpan={10} className="py-8 text-center text-muted">Không có hoá đơn nào khớp bộ lọc.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">Thanh toán tạo giao dịch ở Sổ quỹ (Nợ 201 / Có TK tiền). Huỷ giao dịch đó ở Sổ quỹ thì hoá đơn tự trừ lại số đã trả.</p>
    </div>
  );
}
