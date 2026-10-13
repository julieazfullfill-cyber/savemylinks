// Màn 4 (GĐ4): tab Phải thu + tab Nghĩa vụ thuế, cạnh tab Phải trả NCC có sẵn.
import Link from "next/link";
import { bizDateStr, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { AGING_COLUMNS, agingBuckets, isLate, TAX_KINDS } from "@/lib/receivables";
import { Badge, Field, Flash, PageHead } from "../ui";
import { createArAction, createTaxAction, payTaxAction, receiveArAction } from "./actions";

export const TABS = [
  ["", "Phải trả NCC"],
  ["phai-thu", "Phải thu"],
  ["thue", "Nghĩa vụ thuế"],
] as const;

export function TabBar({ tab }: { tab: string }) {
  return (
    <div className="mt-4 flex flex-wrap gap-2 text-sm">
      {TABS.map(([k, l]) => (
        <Link key={k} href={k ? `/cong-no?tab=${k}` : "/cong-no"} className={`rounded-md px-3 py-1.5 ${tab === k ? "bg-accent text-white" : "bg-surface hover:bg-page"}`}>{l}</Link>
      ))}
    </div>
  );
}

const STATUS = { OPEN: "Chưa thu", PARTIAL: "Thu một phần", PAID: "Đã thu đủ" } as Record<string, string>;

async function cashOptions() {
  const accounts = await prisma.cashAccount.findMany({ where: { active: true }, include: { provider: true }, orderBy: [{ provider: { name: "asc" } }, { code: "asc" }] });
  return accounts.map((a) => ({ value: a.id, label: `${a.provider.name} · ${a.code} (${a.currency})` }));
}

export async function ReceivablesTab({ ok, error }: { ok?: string; error?: string }) {
  const today = todayVn();
  const [list, accounts, opts] = await Promise.all([
    prisma.arInvoice.findMany({ orderBy: [{ status: "asc" }, { dueDate: "asc" }], take: 200 }),
    prisma.account.findMany({ where: { type: { in: ["REVENUE", "OTHER", "COGS", "EXPENSE", "ASSET"] }, code: { notIn: ["131"] } }, orderBy: { code: "asc" } }),
    cashOptions(),
  ]);
  const open = list.filter((i) => i.status !== "PAID");
  const buckets = agingBuckets(open.map((i) => ({ dueDate: i.dueDate, outstandingVnd: i.amountVnd - i.paidVnd })), today);
  const total = buckets.reduce((a, b) => a + b, 0n);
  return (
    <div className="max-w-7xl">
      <PageHead no={4} title="Phải thu" />
      <TabBar tab="phai-thu" />
      <Flash ok={ok} error={error} />
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="card p-4"><div className="text-xs text-ink-2">Tổng còn phải thu</div><div className="mt-1 text-lg font-bold">{formatMoney(total)}</div></div>
        {AGING_COLUMNS.map((l, i) => (
          <div key={l} className={`card p-4 ${i >= 2 && buckets[i] > 0n ? "border-crit/40" : ""}`}>
            <div className="text-xs text-ink-2">{l}</div>
            <div className={`mt-1 font-semibold tabular-nums ${i >= 2 && buckets[i] > 0n ? "text-crit" : ""}`}>{formatMoney(buckets[i])}</div>
          </div>
        ))}
      </div>

      <div className="card mt-4 overflow-x-auto">
        <table className="tbl text-sm">
          <thead><tr><th>Đối tượng</th><th>Ghi nhận</th><th>Hạn thu</th><th className="text-right">Số tiền</th><th className="text-right">Còn lại</th><th>Trạng thái</th><th>Thu tiền</th></tr></thead>
          <tbody>
            {list.map((i) => {
              const late = i.status !== "PAID" && i.dueDate < today;
              return (
                <tr key={i.id}>
                  <td>{i.counterparty}{i.note && <div className="text-xs text-muted">{i.note}</div>}<div className="text-xs text-muted">Có TK {i.accountCode}</div></td>
                  <td className="tabular-nums">{fmtBizDate(i.issueDate)}</td>
                  <td className={`tabular-nums ${late ? "font-semibold text-crit" : ""}`}>{fmtBizDate(i.dueDate)}</td>
                  <td className="text-right tabular-nums">{formatMoney(i.amountVnd)}</td>
                  <td className="text-right tabular-nums">{formatMoney(i.amountVnd - i.paidVnd)}</td>
                  <td><Badge tone={i.status === "PAID" ? "good" : late ? "crit" : "muted"}>{STATUS[i.status]}</Badge></td>
                  <td>
                    {i.status !== "PAID" && (
                      <form action={receiveArAction.bind(null, i.id)} className="flex flex-wrap gap-1">
                        <select className="input w-44" name="accountId" required aria-label="Tài khoản nhận" defaultValue="">
                          <option value="" disabled>Vào tài khoản…</option>
                          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        <input className="input w-28" name="amount" required inputMode="decimal" placeholder="Số tiền" aria-label="Số tiền thu" />
                        <input className="input w-36" name="date" type="date" required defaultValue={bizDateStr(today)} aria-label="Ngày thu" />
                        <button className="btn" type="submit">Thu</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan={7} className="py-6 text-center text-muted">Chưa có khoản phải thu nào.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-muted">Số tiền thu theo tiền của tài khoản nhận (USD thì quy theo tỷ giá ngày thu). Huỷ giao dịch thu ở Sổ quỹ thì số đã thu tự tính lại.</p>

      <form action={createArAction} className="card mt-6 p-5">
        <h2 className="font-bold">Ghi nhận khoản phải thu</h2>
        <p className="mt-1 text-sm text-ink-2">Cho thuê tài khoản, NCC hoàn tiền, tạm ứng chưa quyết toán… Ghi Nợ 131 / Có TK đối ứng.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field name="counterparty" label="Đối tượng" required placeholder="VD: Anh Minh thuê TK Etsy" />
          <Field name="amountVnd" label="Số tiền (VND)" required inputMode="numeric" />
          <Field name="accountCode" label="TK đối ứng (ghi Có)" required defaultValue="409" empty={false} options={accounts.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} />
          <Field name="issueDate" label="Ngày ghi nhận" type="date" required defaultValue={bizDateStr(today)} />
          <Field name="dueDate" label="Hạn thu" type="date" required />
          <Field name="note" label="Ghi chú" />
        </div>
        <button className="btn btn-primary mt-3" type="submit">Ghi nhận</button>
      </form>
    </div>
  );
}

export async function TaxTab({ ok, error }: { ok?: string; error?: string }) {
  const today = todayVn();
  const [list, entities, opts] = await Promise.all([
    prisma.taxObligation.findMany({ include: { entity: true }, orderBy: [{ status: "asc" }, { dueDate: "asc" }], take: 200 }),
    prisma.legalEntity.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    cashOptions(),
  ]);
  const open = list.filter((t) => t.status !== "PAID");
  const lateSum = open.filter((t) => isLate(t, today)).reduce((a, t) => a + t.amountVnd - t.paidVnd, 0n);
  return (
    <div className="max-w-7xl">
      <PageHead no={4} title="Nghĩa vụ thuế & phí" />
      <TabBar tab="thue" />
      <Flash ok={ok} error={error} />
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="card p-4"><div className="text-xs text-ink-2">Chưa nộp</div><div className="mt-1 text-lg font-bold">{formatMoney(open.reduce((a, t) => a + t.amountVnd - t.paidVnd, 0n))}</div><div className="text-xs text-muted">{open.length} khoản — đã vào dự báo 13 tuần</div></div>
        <div className={`card p-4 ${lateSum > 0n ? "border-crit/40 bg-red-50" : ""}`}><div className="text-xs text-ink-2">Quá hạn</div><div className={`mt-1 text-lg font-bold ${lateSum > 0n ? "text-crit" : ""}`}>{formatMoney(lateSum)}</div></div>
      </div>
      <div className="card mt-4 overflow-x-auto">
        <table className="tbl text-sm">
          <thead><tr><th>Loại</th><th>Kỳ</th><th>Pháp nhân</th><th>Hạn nộp</th><th className="text-right">Số tiền</th><th>Trạng thái</th><th>Nộp</th></tr></thead>
          <tbody>
            {list.map((t) => {
              const late = isLate(t, today);
              return (
                <tr key={t.id}>
                  <td>{TAX_KINDS[t.kind]?.label ?? t.kind}<div className="text-xs text-muted">Nợ TK {TAX_KINDS[t.kind]?.gl}</div></td>
                  <td>{t.periodLabel}</td>
                  <td>{t.entity?.code ?? "—"}</td>
                  <td className={`tabular-nums ${late ? "font-semibold text-crit" : ""}`}>{fmtBizDate(t.dueDate)}</td>
                  <td className="text-right tabular-nums">{formatMoney(t.amountVnd)}</td>
                  <td><Badge tone={t.status === "PAID" ? "good" : late ? "crit" : "muted"}>{t.status === "PAID" ? "Đã nộp" : late ? "Quá hạn" : "Chưa nộp"}</Badge></td>
                  <td>
                    {t.status !== "PAID" && (
                      <form action={payTaxAction.bind(null, t.id)} className="flex flex-wrap gap-1">
                        <select className="input w-44" name="accountId" required aria-label="Nộp từ tài khoản" defaultValue="">
                          <option value="" disabled>Từ tài khoản…</option>
                          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        <input className="input w-28" name="amount" required inputMode="decimal" defaultValue={String(t.amountVnd - t.paidVnd)} aria-label="Số tiền nộp" />
                        <input className="input w-36" name="date" type="date" required defaultValue={bizDateStr(today)} aria-label="Ngày nộp" />
                        <button className="btn" type="submit">Nộp</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan={7} className="py-6 text-center text-muted">Chưa có nghĩa vụ nào.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-muted">
        TNCN và BHXH đã ghi vào 204 / 203 khi duyệt kỳ lương — nộp ở đây chỉ tất toán khoản phải nộp (dự báo không cộng lần hai vì đã có trong dòng lương). Thuế HKD, duy trì
        LLC ghi thẳng chi phí 608. Gia hạn / báo cáo của pháp nhân (không có tiền thuế) vẫn ở màn 16.
      </p>

      <form action={createTaxAction} className="card mt-6 p-5">
        <h2 className="font-bold">Thêm nghĩa vụ</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field name="kind" label="Loại" required empty={false} options={Object.entries(TAX_KINDS).map(([k, v]) => ({ value: k, label: v.label }))} />
          <Field name="periodLabel" label="Kỳ" required placeholder="VD: Q3/2026 hoặc 09/2026" />
          <Field name="entityId" label="Pháp nhân" options={entities.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` }))} />
          <Field name="dueDate" label="Hạn nộp" type="date" required />
          <Field name="amountVnd" label="Số tiền (VND)" required inputMode="numeric" />
        </div>
        <button className="btn btn-primary mt-3" type="submit">Thêm</button>
      </form>
    </div>
  );
}
