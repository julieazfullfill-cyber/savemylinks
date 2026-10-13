import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { totalPayroll } from "@/lib/payroll";
import { periodLabel, suggestStandardDays } from "@/lib/payroll-service";
import { Badge, Field, Flash, PageHead } from "../ui";
import { createPeriodAction } from "./actions";
import { STATUS_VI } from "./status";

export default async function PeriodsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const me = await requireUser(["ADMIN", "KE_TOAN", "QUAN_LY"]);
  const sp = await searchParams;
  const today = todayVn();
  const [periods, holidays] = await Promise.all([
    prisma.payrollPeriod.findMany({ include: { lines: true }, orderBy: [{ year: "desc" }, { month: "desc" }] }),
    prisma.holiday.findMany({ where: { paid: true } }),
  ]);
  // Mặc định tạo kỳ của tháng trước (lương trả đầu tháng sau).
  const prevM = today.getUTCMonth() === 0 ? 12 : today.getUTCMonth();
  const prevY = today.getUTCMonth() === 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
  const suggested = suggestStandardDays(prevY, prevM, holidays.map((h) => h.date));

  return (
    <div className="max-w-6xl">
      <PageHead no={13} title="Kỳ lương" />
      <Flash ok={sp.ok} error={sp.error} />
      <p className="mt-2 text-sm text-ink-2">Nháp → Tính → Duyệt (sinh bút toán) → Chi (Sổ quỹ) → Khoá. Tổng kỳ luôn là cộng các dòng — không có ô gõ tổng.</p>

      {(me.role === "ADMIN" || me.role === "KE_TOAN") && (
        <form action={createPeriodAction} className="card mt-4 grid gap-3 p-5 sm:grid-cols-4">
          <Field name="thang" label="Tháng lương" type="month" required defaultValue={`${prevY}-${String(prevM).padStart(2, "0")}`} />
          <Field name="standardDays" label="Ngày công chuẩn" required inputMode="decimal" defaultValue={String(suggested)} help="Gợi ý: T2–T7 trừ lễ có lương" />
          <Field name="profit" label="Lợi nhuận công ty tháng (đ)" inputMode="numeric" help="Âm = lỗ → thưởng bị giữ. Trống = chưa biết, cũng giữ." />
          <div className="flex items-end"><button className="btn-primary" type="submit">Tạo kỳ</button></div>
        </form>
      )}

      <div className="card mt-4 overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Kỳ</th><th>Trạng thái</th><th className="text-right">Số người</th><th className="text-right">Thực nhận</th><th className="text-right">Chi phí công ty</th><th className="text-right">Thưởng bị giữ</th></tr></thead>
          <tbody>
            {periods.map((p) => {
              const t = totalPayroll(p.lines);
              return (
                <tr key={p.id}>
                  <td><Link className="font-semibold text-accent hover:underline" href={`/ky-luong/${p.id}`}>Tháng {periodLabel(p)}</Link></td>
                  <td><Badge tone={STATUS_VI[p.status][1]}>{STATUS_VI[p.status][0]}</Badge></td>
                  <td className="text-right tabular-nums">{t.headcount || "—"}</td>
                  <td className="text-right tabular-nums">{t.headcount ? formatMoney(t.netVnd) : "—"}</td>
                  <td className="text-right tabular-nums">{t.headcount ? formatMoney(t.companyCostVnd) : "—"}</td>
                  <td className={`text-right tabular-nums ${t.bonusHeldVnd > 0n ? "text-crit" : ""}`}>{t.bonusHeldVnd ? formatMoney(t.bonusHeldVnd) : "—"}</td>
                </tr>
              );
            })}
            {!periods.length && <tr><td colSpan={6} className="py-6 text-center text-muted">Chưa có kỳ lương nào.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
