import { monthDays } from "@/lib/attendance";
import { requireUser } from "@/lib/auth";
import { addDays, bizDateStr, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { monthRange, suggestStandardDays } from "@/lib/payroll-service";
import { Field, Flash, PageHead } from "../ui";
import { addHoliday, removeHoliday, saveGrid } from "./actions";
import { AttendanceGrid } from "./grid";

export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ thang?: string; ok?: string; error?: string }> }) {
  await requireUser(["ADMIN", "QUAN_LY"]);
  const sp = await searchParams;
  const today = todayVn();
  const m = /^(\d{4})-(\d{2})$/.exec(sp.thang ?? "");
  const year = m ? +m[1] : today.getUTCFullYear();
  const month = m ? +m[2] : today.getUTCMonth() + 1;
  const thang = `${year}-${String(month).padStart(2, "0")}`;
  const [from, to] = monthRange(year, month);
  const days = monthDays(year, month);

  const [employees, holidays, attendance, leaves, period] = await Promise.all([
    prisma.employee.findMany({
      where: { joinedAt: { lte: to }, OR: [{ leftAt: null }, { leftAt: { gte: from } }] },
      orderBy: { code: "asc" },
    }),
    prisma.holiday.findMany({ where: { date: { gte: addDays(from, -366), lte: addDays(to, 366) } }, orderBy: { date: "asc" } }),
    prisma.attendanceDay.findMany({ where: { date: { gte: from, lte: to } } }),
    prisma.leaveRequest.findMany({ where: { status: "APPROVED", fromDate: { lte: to }, toDate: { gte: from } } }),
    prisma.payrollPeriod.findUnique({ where: { year_month: { year, month } } }),
  ]);
  const holidayBy = new Map(holidays.map((h) => [bizDateStr(h.date), h]));
  const locked = !!period && period.status !== "DRAFT" && period.status !== "CALCULATED";

  const initial: Record<string, string> = {};
  for (const a of attendance) initial[`${a.employeeId}_${bizDateStr(a.date)}`] = String(Number(a.value));
  const leaveKeys: string[] = [];
  for (const l of leaves) for (let d = l.fromDate; d <= l.toDate; d = addDays(d, 1)) leaveKeys.push(`${l.employeeId}_${bizDateStr(d)}`);

  const paidHolidaysThisMonth = holidays.filter((h) => h.paid && h.date >= from && h.date <= to).map((h) => h.date);
  const prev = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;

  return (
    <div className="max-w-[1400px]">
      <PageHead no={11} title={`Lưới chấm công tháng ${month}/${year}`}>
        <div className="flex items-end gap-2">
          <a className="btn" href={`/cham-cong?thang=${prev}`}>←</a>
          <form method="get" className="flex items-end gap-2">
            <input className="input" name="thang" type="month" defaultValue={thang} aria-label="Tháng" />
            <button className="btn" type="submit">Xem</button>
          </form>
          <a className="btn" href={`/cham-cong?thang=${next}`}>→</a>
        </div>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <p className="mt-2 text-sm text-ink-2">
        Ngày công gợi ý tháng này (T2–T7 trừ lễ có lương): <strong>{suggestStandardDays(year, month, paidHolidaysThisMonth)}</strong>.
        {locked && <span className="text-crit"> Kỳ lương tháng này đã {period!.status} — lưới đã khoá.</span>}
      </p>

      <div className="mt-3">
        {employees.length ? (
          <AttendanceGrid
            action={saveGrid.bind(null, year, month, employees.map((e) => e.id))}
            employees={employees.map((e) => ({ id: e.id, code: e.code, name: e.fullName, online: e.workMode === "ONLINE" }))}
            days={days.map((d) => ({ date: bizDateStr(d), dow: d.getUTCDay(), holiday: holidayBy.get(bizDateStr(d))?.name ?? null }))}
            initial={initial}
            leaves={leaveKeys}
            locked={locked}
          />
        ) : (
          <p className="card p-6 text-center text-sm text-muted">Chưa có nhân sự nào làm việc trong tháng này — thêm ở màn 9.</p>
        )}
      </div>

      <section className="card mt-6 max-w-3xl p-5">
        <h2 className="font-bold">Ngày lễ</h2>
        <form action={addHoliday.bind(null, thang)} className="mt-3 grid gap-3 sm:grid-cols-4">
          <Field name="date" label="Ngày" type="date" required />
          <Field name="name" label="Tên" required placeholder="Tết Dương lịch" />
          <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name="paid" defaultChecked /> Có lương</label>
          <div className="flex items-end"><button className="btn-primary" type="submit">Lưu</button></div>
        </form>
        <ul className="mt-3 divide-y divide-hair text-sm">
          {holidays.filter((h) => h.date.getUTCFullYear() === year).map((h) => (
            <li key={h.date.toISOString()} className="flex items-center justify-between py-1.5">
              <span>{fmtBizDate(h.date)} · {h.name}{!h.paid && <span className="text-muted"> (không lương)</span>}</span>
              <form action={removeHoliday.bind(null, thang, bizDateStr(h.date))}><button className="text-xs text-crit hover:underline" type="submit">Bỏ</button></form>
            </li>
          ))}
          {!holidays.some((h) => h.date.getUTCFullYear() === year) && <li className="py-1.5 text-muted">Chưa có ngày lễ nào trong năm {year}.</li>}
        </ul>
      </section>
    </div>
  );
}
