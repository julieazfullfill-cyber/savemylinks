// Kỳ lương trên DB — nối động cơ (payroll.ts) với chấm công, hợp đồng, KPI và sổ cái.
// Quy trình: DRAFT -> CALCULATED -> APPROVED (sinh bút toán) -> PAID -> CLOSED.
// Mọi hàm nhận `tx` — gọi bên trong prisma.$transaction.
import { audit } from "./audit";
import { addDays, dayOfMonth } from "./dates";
import type { Tx } from "./db";
import { bonusGate } from "./kpi";
import { assertBalanced, postCashTxn } from "./ledger";
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

  const [attendance, leaves, holidays, kpis, adjustments] = await Promise.all([
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
    tx.payrollAdjustment.findMany({ where: { periodId } }),
  ]);
  const worked = new Map(attendance.map((a) => [a.employeeId, Number(a._sum.value ?? 0)]));
  const bonus = new Map(kpis.map((k) => [k.employeeId, k.bonusVnd]));
  const adj = new Map(adjustments.map((a) => [a.employeeId, a]));

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

    // Phê duyệt vượt cấp (màn 15) cho chi thưởng dù tháng lỗ.
    const gate = bonusGate(bonus.get(e.id) ?? 0n, period.companyProfitVnd, !!period.bonusOverrideBy);
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
      perfPayVnd: adj.get(e.id)?.perfPayVnd ?? 0n, // nhập ở màn 13
      penaltyVnd: adj.get(e.id)?.penaltyVnd ?? 0n,
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
  // Thực nhận âm (khấu trừ BHXH/phạt lớn hơn thu nhập) gần như luôn là thiếu chấm công —
  // chặn lại thay vì sinh bút toán lương với số phải trả âm.
  const negative = lines.filter((l) => l.netVnd < 0n).map((l) => employees.find((e) => e.id === l.employeeId)!);
  if (negative.length) {
    throw new Error(
      `Thực nhận âm (kiểm tra chấm công / khấu trừ): ${negative.map((e) => `${e.code} ${e.fullName}`).join(", ")}`,
    );
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

// ------------------------------------------------------- vòng đời kỳ lương (màn 13)

async function editablePeriod(tx: Tx, periodId: string) {
  const p = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } });
  if (p.status !== "DRAFT" && p.status !== "CALCULATED") throw new Error(`Kỳ ${periodLabel(p)} đang ${p.status} — không sửa được`);
  return p;
}

/** Sửa ngày công chuẩn / lợi nhuận công ty. Kỳ về DRAFT — phải tính lại trước khi duyệt. */
export async function updatePeriod(tx: Tx, p: { periodId: string; standardDays: number; companyProfitVnd: bigint | null; actorId: string }) {
  const before = await editablePeriod(tx, p.periodId);
  if (!(p.standardDays > 0 && p.standardDays <= 31)) throw new Error("Ngày công chuẩn phải trong khoảng 0–31");
  const after = await tx.payrollPeriod.update({
    where: { id: p.periodId },
    data: { standardDays: p.standardDays, companyProfitVnd: p.companyProfitVnd, status: "DRAFT" },
  });
  await audit(tx, { actorId: p.actorId, tableName: "PayrollPeriod", recordId: p.periodId, action: "UPDATE", before, after });
  return after;
}

/** Lương hiệu quả / khấu trừ của một người. Kỳ về DRAFT — phải tính lại. */
export async function setAdjustment(
  tx: Tx,
  p: { periodId: string; employeeId: string; perfPayVnd: bigint; penaltyVnd: bigint; note: string | null; actorId: string },
) {
  await editablePeriod(tx, p.periodId);
  if (p.perfPayVnd < 0n || p.penaltyVnd < 0n) throw new Error("Số tiền không được âm");
  const data = { perfPayVnd: p.perfPayVnd, penaltyVnd: p.penaltyVnd, note: p.note };
  const row = await tx.payrollAdjustment.upsert({
    where: { periodId_employeeId: { periodId: p.periodId, employeeId: p.employeeId } },
    create: { periodId: p.periodId, employeeId: p.employeeId, ...data },
    update: data,
  });
  await tx.payrollPeriod.update({ where: { id: p.periodId }, data: { status: "DRAFT" } });
  await audit(tx, { actorId: p.actorId, tableName: "PayrollAdjustment", recordId: row.id, action: "UPDATE", after: row });
  return row;
}

/** Phê duyệt vượt cấp: chi thưởng dù công ty lỗ trong kỳ. Chỉ ADMIN. Kỳ về DRAFT — phải tính lại. */
export async function overrideHeldBonus(tx: Tx, p: { periodId: string; actorId: string; revoke?: boolean }) {
  const before = await editablePeriod(tx, p.periodId);
  const after = await tx.payrollPeriod.update({
    where: { id: p.periodId },
    data: p.revoke
      ? { bonusOverrideBy: null, bonusOverrideAt: null, status: "DRAFT" }
      : { bonusOverrideBy: p.actorId, bonusOverrideAt: new Date(), status: "DRAFT" },
  });
  await audit(tx, { actorId: p.actorId, tableName: "PayrollPeriod", recordId: p.periodId, action: "UPDATE", before, after });
  return after;
}

/** Chi lương: một giao dịch Nợ 202 / Có TK tiền (VND) bằng tổng thực nhận. APPROVED → PAID. */
export async function payPeriod(tx: Tx, p: { periodId: string; accountId: string; date: Date; actorId: string }) {
  const period = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: p.periodId }, include: { lines: true } });
  if (period.status !== "APPROVED") throw new Error(`Chỉ chi được kỳ đã duyệt (đang ${period.status})`);
  const acc = await tx.cashAccount.findUniqueOrThrow({ where: { id: p.accountId } });
  if (acc.currency !== "VND") throw new Error("Chi lương từ tài khoản VND");
  const net = totalPayroll(period.lines).netVnd;
  const txn = await postCashTxn(tx, {
    date: p.date,
    accountId: p.accountId,
    direction: "OUT",
    amount: net,
    counterGl: "202",
    journalSource: "PAYROLL_PAYMENT",
    description: `Chi lương tháng ${periodLabel(period)}`,
    actorId: p.actorId,
  });
  const after = await tx.payrollPeriod.update({ where: { id: p.periodId }, data: { status: "PAID", paidAt: new Date(), paidCashTxnId: txn.id } });
  await audit(tx, { actorId: p.actorId, tableName: "PayrollPeriod", recordId: p.periodId, action: "UPDATE", after });
  return { period: after, txn };
}

/** Nộp BHXH (203) hoặc thuế TNCN (204) của kỳ: giao dịch Nợ 203/204 / Có TK tiền. */
export async function payLiability(
  tx: Tx,
  p: { periodId: string; kind: "INSURANCE" | "PIT"; accountId: string; date: Date; amountVnd: bigint; actorId: string },
) {
  const period = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: p.periodId } });
  if (period.status === "DRAFT" || period.status === "CALCULATED") throw new Error("Kỳ chưa duyệt — chưa có khoản phải nộp");
  const acc = await tx.cashAccount.findUniqueOrThrow({ where: { id: p.accountId } });
  if (acc.currency !== "VND") throw new Error("Nộp từ tài khoản VND");
  return postCashTxn(tx, {
    date: p.date,
    accountId: p.accountId,
    direction: "OUT",
    amount: p.amountVnd,
    counterGl: p.kind === "INSURANCE" ? "203" : "204",
    journalSource: "PAYROLL_PAYMENT",
    description: `Nộp ${p.kind === "INSURANCE" ? "BHXH" : "thuế TNCN"} tháng ${periodLabel(period)}`,
    actorId: p.actorId,
  });
}

/** Khoá kỳ: PAID → CLOSED, bất biến (trigger). Điều chỉnh về sau đi qua kỳ kế tiếp. */
export async function closePeriod(tx: Tx, p: { periodId: string; actorId: string }) {
  const before = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: p.periodId } });
  if (before.status !== "PAID") throw new Error("Chỉ khoá được kỳ đã chi");
  const after = await tx.payrollPeriod.update({ where: { id: p.periodId }, data: { status: "CLOSED", closedAt: new Date() } });
  await audit(tx, { actorId: p.actorId, tableName: "PayrollPeriod", recordId: p.periodId, action: "UPDATE", before, after });
  return after;
}
