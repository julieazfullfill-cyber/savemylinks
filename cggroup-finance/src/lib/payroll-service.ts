// Kỳ lương trên DB — nối động cơ (payroll.ts) với chấm công, hợp đồng, KPI và sổ cái.
// Quy trình: DRAFT -> CALCULATED -> APPROVED (sinh bút toán) -> PAID -> CLOSED.
// Mọi hàm nhận `tx` — gọi bên trong prisma.$transaction.
import { audit } from "./audit";
import { addDays, dayOfMonth } from "./dates";
import type { Tx } from "./db";
import { bonusGate } from "./kpi";
import { assertBalanced } from "./ledger";
import { computePayrollLine, totalPayroll, type ContractSnapshot } from "./payroll";
import { buildPayrollJournal } from "./payroll-journal";
import { loadPayrollSettings } from "./payroll-settings";

export function monthRange(year: number, month: number): [Date, Date] {
  return [dayOfMonth(year, month - 1, 1), dayOfMonth(year, month - 1, 31)];
}

const isSunday = (d: Date) => d.getUTCDay() === 0;

/** Số ngày thứ Hai–thứ Bảy trong [from, to]. */
export function workdaysBetween(from: Date, to: Date): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isSunday(d)) n++;
  return n;
}

/**
 * Gợi ý ngày công chuẩn: thứ Hai–thứ Bảy trừ ngày lễ có lương rơi vào ngày làm việc.
 * Chỉ là gợi ý — chính sách thật (ví dụ tháng 8 = 24) do kế toán chốt khi tạo kỳ.
 */
export function suggestStandardDays(year: number, month: number, paidHolidays: Date[]): number {
  const [from, to] = monthRange(year, month);
  const hol = paidHolidays.filter((h) => h >= from && h <= to && !isSunday(h)).length;
  return workdaysBetween(from, to) - hol;
}

/** Hợp đồng có hiệu lực vào ngày `on` (constraint contract_no_overlap đảm bảo tối đa một). */
export async function contractOn(tx: Tx, employeeId: string, on: Date) {
  return tx.employmentContract.findFirst({
    where: { employeeId, effectiveFrom: { lte: on }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }] },
    orderBy: { effectiveFrom: "desc" },
  });
}

export async function createPeriod(
  tx: Tx,
  p: { year: number; month: number; standardDays: number; companyProfitVnd?: bigint | null; actorId: string },
) {
  if (!(p.standardDays > 0 && p.standardDays <= 31)) throw new Error("Ngày công chuẩn phải trong khoảng 0–31");
  const period = await tx.payrollPeriod.create({
    data: { year: p.year, month: p.month, standardDays: p.standardDays, companyProfitVnd: p.companyProfitVnd ?? null },
  });
  await audit(tx, { actorId: p.actorId, tableName: "PayrollPeriod", recordId: period.id, action: "CREATE", after: period });
  return period;
}

/**
 * Tính (hoặc tính lại) toàn bộ dòng lương của kỳ. Chỉ khi kỳ đang DRAFT/CALCULATED.
 *  - Nhân sự: mọi người có thời gian làm việc giao với tháng (không lọc theo status,
 *    để người nghỉ giữa tháng vẫn có dòng lương).
 *  - Hợp đồng: bản có hiệu lực vào ngày cuối cùng người đó làm trong tháng.
 *    Thiếu hợp đồng → báo lỗi tên từng người, KHÔNG bỏ qua.
 *  - Ngày tính lương = công chấm + phép có lương + lễ có lương (tối đa ngày công chuẩn).
 *  - Thưởng doanh số = KpiResult.bonusVnd, qua bonusGate với lợi nhuận công ty của kỳ.
 */
export async function calculatePeriod(tx: Tx, periodId: string, actorId: string) {
  const period = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } });
  if (period.status !== "DRAFT" && period.status !== "CALCULATED") {
    throw new Error(`Kỳ ${period.month}/${period.year} đang ${period.status} — không tính lại được`);
  }
  const [from, to] = monthRange(period.year, period.month);
  const standardDays = Number(period.standardDays);
  const settings = await loadPayrollSettings(tx);

  const employees = await tx.employee.findMany({
    where: { joinedAt: { lte: to }, OR: [{ leftAt: null }, { leftAt: { gte: from } }] },
    orderBy: { code: "asc" },
  });

  const [attendance, leaves, holidays, kpis] = await Promise.all([
    tx.attendanceDay.groupBy({
      by: ["employeeId"],
      where: { date: { gte: from, lte: to } },
      _sum: { value: true },
    }),
    tx.leaveRequest.findMany({
      where: { status: "APPROVED", leaveType: { paid: true }, fromDate: { lte: to }, toDate: { gte: from } },
    }),
    tx.holiday.findMany({ where: { paid: true, date: { gte: from, lte: to } } }),
    tx.kpiResult.findMany({ where: { year: period.year, month: period.month } }),
  ]);
  const worked = new Map(attendance.map((a) => [a.employeeId, Number(a._sum.value ?? 0)]));
  const bonus = new Map(kpis.map((k) => [k.employeeId, k.bonusVnd]));

  const missing: string[] = [];
  const lines = [];
  for (const e of employees) {
    const start = e.joinedAt > from ? e.joinedAt : from;
    const end = e.leftAt && e.leftAt < to ? e.leftAt : to;
    const c = await contractOn(tx, e.id, end);
    if (!c) {
      missing.push(`${e.code} ${e.fullName}`);
      continue;
    }

    // Phép có lương: phần nằm trong tháng. Đơn trọn trong tháng lấy đúng số ngày đơn
    // (có thể là nửa ngày); đơn vắt qua tháng tính theo ngày làm việc giao nhau.
    const paidLeave = leaves
      .filter((l) => l.employeeId === e.id)
      .reduce((a, l) => {
        if (l.fromDate >= from && l.toDate <= to) return a + Number(l.days);
        const s = l.fromDate > from ? l.fromDate : from;
        const t = l.toDate < to ? l.toDate : to;
        return a + Math.min(workdaysBetween(s, t), Number(l.days));
      }, 0);
    const paidHolidays = holidays.filter((h) => h.date >= start && h.date <= end && !isSunday(h.date)).length;
    const attended = worked.get(e.id) ?? 0;

    const gate = bonusGate(bonus.get(e.id) ?? 0n, period.companyProfitVnd);
    const snapshot: ContractSnapshot = {
      baseSalaryVnd: c.baseSalaryVnd,
      allowanceVnd: c.allowanceVnd,
      mealVnd: c.mealVnd,
      transportVnd: c.transportVnd,
      dutyVnd: c.dutyVnd,
      insuranceSalaryVnd: c.insuranceSalaryVnd,
      dependents: c.dependents,
    };
    const r = computePayrollLine({
      employeeId: e.id,
      contract: snapshot,
      workedDays: attended + paidLeave + paidHolidays,
      standardDays,
      salesBonusVnd: gate.payableVnd,
      bonusHeldVnd: gate.heldVnd,
      perfPayVnd: 0n, // GĐ2 tuần 3: nhập lương hiệu quả trên màn 13
      penaltyVnd: 0n, // GĐ2 tuần 3: nhập khấu trừ trên màn 13
      insurance: settings.insurance,
      pit: settings.pit,
      mealExemptCapVnd: settings.mealExemptCapVnd,
    });
    lines.push({
      periodId,
      employeeId: e.id,
      workedDays: attended,
      leaveDays: paidLeave + paidHolidays,
      baseSalaryVnd: r.baseSalaryVnd,
      proratedVnd: r.proratedVnd,
      allowanceVnd: r.allowanceVnd,
      salesBonusVnd: r.salesBonusVnd,
      perfPayVnd: r.perfPayVnd,
      bonusHeldVnd: r.bonusHeldVnd,
      insuranceEmpVnd: r.insuranceEmpVnd,
      insuranceCoVnd: r.insuranceCoVnd,
      pitVnd: r.pitVnd,
      penaltyVnd: r.penaltyVnd,
      netVnd: r.netVnd,
      note: gate.reason,
    });
  }
  if (missing.length) {
    throw new Error(`Chưa có hợp đồng hiệu lực trong tháng ${period.month}/${period.year}: ${missing.join(", ")}`);
  }

  await tx.payrollLine.deleteMany({ where: { periodId } });
  await tx.payrollLine.createMany({ data: lines });
  const after = await tx.payrollPeriod.update({
    where: { id: periodId },
    data: { status: "CALCULATED", calculatedAt: new Date() },
  });
  await audit(tx, {
    actorId,
    tableName: "PayrollPeriod",
    recordId: periodId,
    action: "UPDATE",
    before: period,
    after: { ...after, totals: totalPayroll(lines), usingDefaults: settings.usingDefaults },
  });
  return { period: after, totals: totalPayroll(lines), usingDefaults: settings.usingDefaults };
}

/**
 * Duyệt kỳ: sinh bút toán lương (ngày cuối tháng) từ chính các dòng đã lưu, gắn journalId.
 * Sau bước này trigger khoá các dòng lương.
 */
export async function approvePeriod(tx: Tx, periodId: string, actorId: string) {
  const period = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId }, include: { lines: true } });
  if (period.status !== "CALCULATED") throw new Error(`Chỉ duyệt được kỳ đã tính (đang ${period.status})`);
  if (!period.lines.length) throw new Error("Kỳ lương không có dòng nào");

  const draft = buildPayrollJournal(period.lines);
  assertBalanced(draft);
  const [, monthEnd] = monthRange(period.year, period.month);
  const journal = await tx.journalEntry.create({
    data: {
      date: monthEnd,
      memo: `Lương tháng ${period.month}/${period.year}`,
      source: "PAYROLL",
      createdBy: actorId,
      lines: { create: draft },
    },
  });
  const after = await tx.payrollPeriod.update({
    where: { id: periodId },
    data: { status: "APPROVED", approvedBy: actorId, approvedAt: new Date(), journalId: journal.id },
  });
  const before: Partial<typeof period> = { ...period };
  delete before.lines;
  await audit(tx, { actorId, tableName: "PayrollPeriod", recordId: periodId, action: "UPDATE", before, after });
  return { period: after, journalId: journal.id, totals: totalPayroll(period.lines) };
}

/** Lương cứng của mỗi người tại một tháng bất kỳ — "tra được lương của bất kỳ tháng nào". */
export async function salaryAt(tx: Tx, year: number, month: number) {
  const [from, to] = monthRange(year, month);
  const employees = await tx.employee.findMany({
    where: { joinedAt: { lte: to }, OR: [{ leftAt: null }, { leftAt: { gte: from } }] },
    include: { department: true, position: true },
    orderBy: { code: "asc" },
  });
  return Promise.all(
    employees.map(async (e) => ({ employee: e, contract: await contractOn(tx, e.id, e.leftAt && e.leftAt < to ? e.leftAt : to) })),
  );
}

export const periodLabel = (p: { year: number; month: number }) => `${String(p.month).padStart(2, "0")}/${p.year}`;
