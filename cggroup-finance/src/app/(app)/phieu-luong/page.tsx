import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { fmtTimestamp } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { periodLabel } from "@/lib/payroll-service";
import { PageHead } from "../ui";
import { PrintButton } from "./print-button";

/** Màn 14 — Phiếu lương. Nhân viên chỉ thấy phiếu của mình; kế toán/giám đốc thấy tất cả. Chỉ kỳ đã duyệt. */
export default async function PayslipPage({ searchParams }: { searchParams: Promise<{ ky?: string; nv?: string }> }) {
  const me = await requireUser();
  const sp = await searchParams;
  const all = me.role === "ADMIN" || me.role === "KE_TOAN" || me.role === "QUAN_LY";
  const own = await prisma.employee.findUnique({ where: { userId: me.uid } });

  const scope: Prisma.PayrollLineWhereInput = {
    period: { status: { in: ["APPROVED", "PAID", "CLOSED"] } },
    ...(all ? {} : { employeeId: own?.id ?? "__none__" }),
  };
  const selected =
    sp.ky && sp.nv
      ? await prisma.payrollLine.findFirst({
          where: { ...scope, periodId: sp.ky, employeeId: sp.nv },
          include: { period: true, employee: { include: { department: true, position: true } } },
        })
      : null;
  const list = await prisma.payrollLine.findMany({
    where: scope,
    include: { period: true, employee: true },
    orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }, { employee: { code: "asc" } }],
    take: 300,
  });

  if (!all && !own) {
    return (
      <div className="max-w-3xl">
        <PageHead no={14} title="Phiếu lương" />
        <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm">Tài khoản chưa gắn với hồ sơ nhân sự — nhờ HR gắn ở màn 9 để xem phiếu lương.</p>
      </div>
    );
  }

  if (selected) {
    const l = selected;
    const gross = l.proratedVnd + l.allowanceVnd + l.salesBonusVnd + l.perfPayVnd;
    const rows: [string, bigint, boolean?][] = [
      ["Lương theo ngày công", l.proratedVnd],
      ["Phụ cấp", l.allowanceVnd],
      ["Thưởng doanh số", l.salesBonusVnd],
      ["Lương hiệu quả", l.perfPayVnd],
      ["Tổng thu nhập", gross, true],
      ["BHXH, BHYT, BHTN (người lao động)", -l.insuranceEmpVnd],
      ["Thuế TNCN", -l.pitVnd],
      ["Khấu trừ khác", -l.penaltyVnd],
    ];
    return (
      <div className="max-w-2xl">
        <div className="no-print mb-3 flex items-center justify-between">
          <Link href="/phieu-luong" className="text-sm text-accent hover:underline">← Danh sách phiếu</Link>
          <PrintButton />
        </div>
        <article className="card p-8 print:border-0 print:p-0">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-accent">CGGroup</div>
              <h1 className="mt-1 text-xl font-bold">Phiếu lương tháng {periodLabel(l.period)}</h1>
            </div>
            <div className="text-right text-sm">
              <div className="font-semibold">{l.employee.fullName}</div>
              <div className="text-muted">{l.employee.code} · {l.employee.department?.name ?? ""} {l.employee.position ? `· ${l.employee.position.name}` : ""}</div>
            </div>
          </div>
          <dl className="mt-6 grid grid-cols-3 gap-3 text-sm">
            <div><dt className="text-muted">Ngày công chuẩn</dt><dd className="font-semibold">{Number(l.period.standardDays)}</dd></div>
            <div><dt className="text-muted">Ngày công chấm</dt><dd className="font-semibold">{Number(l.workedDays)}</dd></div>
            <div><dt className="text-muted">Phép + lễ có lương</dt><dd className="font-semibold">{Number(l.leaveDays)}</dd></div>
            <div><dt className="text-muted">Lương cứng hợp đồng</dt><dd className="font-semibold">{formatMoney(l.baseSalaryVnd)}</dd></div>
          </dl>
          <table className="mt-6 w-full text-sm">
            <tbody>
              {rows.map(([label, v, strong]) => (
                <tr key={label} className={`border-b border-hair ${strong ? "font-semibold" : ""}`}>
                  <td className="py-2">{label}</td>
                  <td className="py-2 text-right tabular-nums">{v === 0n ? "—" : formatMoney(v)}</td>
                </tr>
              ))}
              <tr className="text-base font-bold">
                <td className="pt-3">Thực nhận</td>
                <td className="pt-3 text-right tabular-nums">{formatMoney(l.netVnd)}</td>
              </tr>
            </tbody>
          </table>
          {l.bonusHeldVnd > 0n && (
            <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm">
              Thưởng doanh số {formatMoney(l.bonusHeldVnd)} đang được giữ lại (công ty lỗ trong kỳ), sẽ chi khi được phê duyệt.
            </p>
          )}
          {l.employee.bankAccount && <p className="mt-4 text-sm text-ink-2">Chuyển khoản: {l.employee.bankAccount} · {l.employee.bankName}</p>}
          <p className="mt-6 text-xs text-muted">In lúc {fmtTimestamp(new Date())}. Thắc mắc liên hệ bộ phận kế toán.</p>
        </article>
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <PageHead no={14} title="Phiếu lương" />
      <div className="card mt-4 overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Kỳ</th><th>Nhân sự</th><th className="text-right">Thực nhận</th><th /></tr></thead>
          <tbody>
            {list.map((l) => (
              <tr key={l.id}>
                <td>Tháng {periodLabel(l.period)}</td>
                <td>{l.employee.code} · {l.employee.fullName}</td>
                <td className="text-right tabular-nums">{formatMoney(l.netVnd)}</td>
                <td><Link className="text-accent hover:underline" href={`/phieu-luong?ky=${l.periodId}&nv=${l.employeeId}`}>Xem / in</Link></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={4} className="py-6 text-center text-muted">Chưa có phiếu lương nào (kỳ lương cần được duyệt).</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
