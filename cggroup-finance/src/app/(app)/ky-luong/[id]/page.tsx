import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { bizDateStr, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { totalPayroll } from "@/lib/payroll";
import { monthRange, periodLabel } from "@/lib/payroll-service";
import { loadPayrollSettings } from "@/lib/payroll-settings";
import { Field, Flash } from "../../ui";
import {
  approveAction,
  calculateAction,
  closeAction,
  overrideAction,
  payAction,
  payLiabilityAction,
  saveAdjustments,
  updatePeriodAction,
} from "../actions";
import { STATUS_VI, STEPS } from "../status";

// Bảng lương dày đặc: số không kèm ký hiệu ₫ (tiêu đề bảng ghi đơn vị), không xuống dòng.
const num = (v: bigint) => formatMoney(v).replace(" ₫", "");
const m = (v: bigint) => (v ? num(v) : "—");

export default async function PeriodPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const me = await requireUser(["ADMIN", "KE_TOAN", "QUAN_LY"]);
  const { id } = await params;
  const sp = await searchParams;
  const period = await prisma.payrollPeriod.findUnique({ where: { id }, include: { lines: { include: { employee: true } }, adjustments: true } });
  if (!period) notFound();

  const [from, to] = monthRange(period.year, period.month);
  const [employees, accounts, settings, users] = await Promise.all([
    prisma.employee.findMany({ where: { joinedAt: { lte: to }, OR: [{ leftAt: null }, { leftAt: { gte: from } }] }, orderBy: { code: "asc" } }),
    prisma.cashAccount.findMany({ where: { active: true, currency: "VND" }, include: { provider: true }, orderBy: { code: "asc" } }),
    prisma.$transaction((tx) => loadPayrollSettings(tx)),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const adj = new Map(period.adjustments.map((a) => [a.employeeId, a]));
  const lines = [...period.lines].sort((a, b) => a.employee.code.localeCompare(b.employee.code));
  const t = totalPayroll(lines);
  const editable = period.status === "DRAFT" || period.status === "CALCULATED";
  const accountant = me.role === "ADMIN" || me.role === "KE_TOAN";
  const director = me.role === "ADMIN" || me.role === "QUAN_LY";
  const today = bizDateStr(todayVn());
  const stepIdx = STEPS.indexOf(period.status);

  const payForm = (action: (f: FormData) => void | Promise<void>, label: string, amount?: bigint) => (
    <form action={action} className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
      <select className="input" name="accountId" required defaultValue="">
        <option value="">Từ tài khoản VND…</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.provider.name} · {a.code}</option>)}
      </select>
      <input className="input" name="date" type="date" required defaultValue={today} aria-label="Ngày" />
      {amount !== undefined && <input className="input w-40" name="amount" required defaultValue={amount.toString()} inputMode="numeric" aria-label="Số tiền" />}
      <button className="btn-primary" type="submit">{label}</button>
    </form>
  );

  return (
    <div className="max-w-[1400px]">
      <Link href="/ky-luong" className="text-sm text-accent hover:underline">← Các kỳ lương</Link>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-muted">Màn hình 13</div>
          <h1 className="text-2xl font-bold">Kỳ lương tháng {periodLabel(period)}</h1>
        </div>
        <ol className="flex flex-wrap gap-1 text-xs" aria-label="Trạng thái">
          {STEPS.map((s, i) => (
            <li key={s} className={`rounded-full px-2.5 py-1 ${i === stepIdx ? "bg-accent font-semibold text-white" : i < stepIdx ? "bg-accent/15 text-accent" : "bg-page text-muted"}`}>
              {i + 1}. {STATUS_VI[s][0]}
            </li>
          ))}
        </ol>
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      {settings.usingDefaults.length > 0 && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm">⚠ Đang dùng giá trị khởi tạo cho: {settings.usingDefaults.join(", ")} — nhờ kế toán xác nhận trong PayrollSetting.</p>
      )}

      {/* Thiết lập kỳ */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <form action={updatePeriodAction.bind(null, id)} className="card grid gap-3 p-5 sm:grid-cols-3">
          <Field name="standardDays" label="Ngày công chuẩn" required inputMode="decimal" defaultValue={String(Number(period.standardDays))} disabled={!editable || !accountant} />
          <Field name="profit" label="Lợi nhuận công ty (đ)" inputMode="numeric" defaultValue={period.companyProfitVnd?.toString() ?? ""} disabled={!editable || !accountant} help={period.companyProfitVnd === null ? "Chưa nhập → thưởng bị giữ" : period.companyProfitVnd < 0n ? "Lỗ → thưởng bị giữ" : "Lãi"} />
          <div className="flex items-end">{editable && accountant && <button className="btn" type="submit">Lưu</button>}</div>
        </form>

        <div className="card space-y-3 p-5 text-sm">
          {t.bonusHeldVnd > 0n || period.bonusOverrideBy ? (
            <div>
              <div className="font-semibold">Thưởng bị giữ: {formatMoney(t.bonusHeldVnd)}</div>
              {period.bonusOverrideBy ? (
                <p className="text-ink-2">✓ Đã phê duyệt vượt cấp bởi {userName.get(period.bonusOverrideBy)} — thưởng được chi.</p>
              ) : (
                <p className="text-ink-2">Công ty lỗ / chưa có lợi nhuận kỳ — thưởng không vào lương cho tới khi Admin phê duyệt vượt cấp.</p>
              )}
              {me.role === "ADMIN" && editable && (
                <form action={overrideAction.bind(null, id, !!period.bonusOverrideBy)} className="mt-2">
                  <button className={period.bonusOverrideBy ? "btn" : "btn-primary"} type="submit">
                    {period.bonusOverrideBy ? "Thu hồi phê duyệt" : "Phê duyệt chi thưởng bị giữ"}
                  </button>
                </form>
              )}
            </div>
          ) : (
            <p className="text-ink-2">Không có thưởng bị giữ.</p>
          )}
          <div className="flex flex-wrap gap-2 border-t border-hair pt-3">
            {editable && accountant && <form action={calculateAction.bind(null, id)}><button className="btn-primary" type="submit">{period.status === "DRAFT" ? "Tính lương" : "Tính lại"}</button></form>}
            {period.status === "CALCULATED" && director && <form action={approveAction.bind(null, id)}><button className="btn-primary" type="submit">Duyệt & ghi sổ</button></form>}
            {period.status === "PAID" && accountant && <form action={closeAction.bind(null, id)}><button className="btn" type="submit">Khoá kỳ</button></form>}
            {period.journalId && <span className="self-center text-xs text-muted">Bút toán lương đã ghi ngày cuối tháng</span>}
          </div>
          {period.status === "APPROVED" && accountant && (
            <div className="border-t border-hair pt-3">
              <div className="mb-2 font-semibold">Chi lương — {formatMoney(t.netVnd)}</div>
              {payForm(payAction.bind(null, id), "Chi lương")}
            </div>
          )}
          {(period.status === "APPROVED" || period.status === "PAID") && accountant && (
            <details className="border-t border-hair pt-3">
              <summary className="cursor-pointer text-accent">Nộp BHXH / thuế TNCN</summary>
              <div className="mt-2 space-y-2">
                <div className="text-xs text-muted">BHXH phải nộp (NLĐ + công ty): {formatMoney(t.insuranceEmpVnd + t.insuranceCoVnd)}</div>
                {payForm(payLiabilityAction.bind(null, id, "INSURANCE"), "Nộp BHXH", t.insuranceEmpVnd + t.insuranceCoVnd)}
                <div className="text-xs text-muted">Thuế TNCN đã khấu trừ: {formatMoney(t.pitVnd)}</div>
                {payForm(payLiabilityAction.bind(null, id, "PIT"), "Nộp thuế", t.pitVnd)}
              </div>
            </details>
          )}
        </div>
      </div>

      {/* Điều chỉnh */}
      {editable && accountant && (
        <form action={saveAdjustments.bind(null, id, employees.map((e) => e.id))} className="card mt-4 overflow-x-auto">
          <div className="p-4 pb-0">
            <h2 className="font-bold">Lương hiệu quả & khấu trừ</h2>
            <p className="text-sm text-muted">Nhập trước khi tính. Lưu xong kỳ về Nháp — bấm Tính lương lại.</p>
          </div>
          <table className="tbl mt-2">
            <thead><tr><th>Nhân sự</th><th>Lương hiệu quả (đ)</th><th>Khấu trừ / phạt (đ)</th><th>Ghi chú</th></tr></thead>
            <tbody>
              {employees.map((e) => {
                const a = adj.get(e.id);
                return (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap"><span className="font-mono text-xs text-muted">{e.code}</span> {e.fullName}</td>
                    <td><input className="input w-36" name={`perf_${e.id}`} inputMode="numeric" defaultValue={a?.perfPayVnd ? a.perfPayVnd.toString() : ""} aria-label={`Lương hiệu quả ${e.code}`} /></td>
                    <td><input className="input w-36" name={`pen_${e.id}`} inputMode="numeric" defaultValue={a?.penaltyVnd ? a.penaltyVnd.toString() : ""} aria-label={`Khấu trừ ${e.code}`} /></td>
                    <td><input className="input w-64" name={`note_${e.id}`} defaultValue={a?.note ?? ""} aria-label={`Ghi chú ${e.code}`} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="p-4"><button className="btn" type="submit">Lưu điều chỉnh</button></div>
        </form>
      )}

      {/* Bảng lương */}
      <div className="card mt-4 overflow-x-auto">
        {lines.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">Chưa tính lương kỳ này.</p>
        ) : (
          <table className="tbl text-xs [&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <th>Nhân sự (đơn vị: đồng)</th><th className="text-right">Thực nhận</th><th /><th className="text-right">Công</th><th className="text-right">Phép+lễ</th>
                <th className="text-right">Lương cứng</th><th className="text-right">Theo công</th><th className="text-right">Phụ cấp</th><th className="text-right">Thưởng DS</th>
                <th className="text-right">Giữ lại</th><th className="text-right">Hiệu quả</th><th className="text-right">BHXH NLĐ</th><th className="text-right">TNCN</th><th className="text-right">Phạt</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="min-w-[170px] max-w-[200px] !whitespace-normal">
                    <span className="font-mono text-muted">{l.employee.code}</span> {l.employee.fullName}
                    {l.note && <div className="text-[11px] leading-tight text-crit">{l.note}</div>}
                  </td>
                  <td className="text-right font-semibold tabular-nums">{num(l.netVnd)}</td>
                  <td>{period.status !== "DRAFT" && <Link className="text-accent hover:underline" href={`/phieu-luong?ky=${id}&nv=${l.employeeId}`}>Phiếu</Link>}</td>
                  <td className="text-right tabular-nums">{Number(l.workedDays)}</td>
                  <td className="text-right tabular-nums">{Number(l.leaveDays) || "—"}</td>
                  {[l.baseSalaryVnd, l.proratedVnd, l.allowanceVnd, l.salesBonusVnd].map((v, i) => <td key={i} className="text-right tabular-nums">{m(v)}</td>)}
                  <td className={`text-right tabular-nums ${l.bonusHeldVnd ? "text-crit" : ""}`}>{m(l.bonusHeldVnd)}</td>
                  {[l.perfPayVnd, l.insuranceEmpVnd, l.pitVnd, l.penaltyVnd].map((v, i) => <td key={i} className="text-right tabular-nums">{m(v)}</td>)}
                </tr>
              ))}
              <tr className="bg-page font-semibold">
                <td>Tổng ({t.headcount} người)</td>
                <td className="text-right tabular-nums">{num(t.netVnd)}</td>
                <td /><td /><td /><td />
                <td className="text-right tabular-nums">{m(t.proratedVnd)}</td>
                <td className="text-right tabular-nums">{m(t.allowanceVnd)}</td>
                <td className="text-right tabular-nums">{m(lines.reduce((s, l) => s + l.salesBonusVnd, 0n))}</td>
                <td className="text-right tabular-nums">{m(t.bonusHeldVnd)}</td>
                <td className="text-right tabular-nums">{m(lines.reduce((s, l) => s + l.perfPayVnd, 0n))}</td>
                <td className="text-right tabular-nums">{m(t.insuranceEmpVnd)}</td>
                <td className="text-right tabular-nums">{m(t.pitVnd)}</td>
                <td className="text-right tabular-nums">{m(t.penaltyVnd)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      {lines.length > 0 && (
        <p className="mt-2 text-sm text-ink-2">
          Chi phí công ty thực chịu = thực nhận + BHXH NLĐ + TNCN + BHXH công ty ({formatMoney(t.insuranceCoVnd)}) = <strong>{formatMoney(t.companyCostVnd)}</strong>.
        </p>
      )}
    </div>
  );
}
