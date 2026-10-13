// Màn hình 11 — Lưới chấm công, màn 12 — Nghỉ phép. Phần thuần (không DB) + nghiệp vụ DB.
import { audit } from "./audit";
import { addDays, bizDateStr, dayOfMonth, parseBizDate } from "./dates";
import type { Tx } from "./db";

export const isSunday = (d: Date) => d.getUTCDay() === 0;

/** Mọi ngày trong tháng (month 1–12). */
export function monthDays(year: number, month: number): Date[] {
  const out: Date[] = [];
  const last = dayOfMonth(year, month - 1, 31);
  for (let d = dayOfMonth(year, month - 1, 1); d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Ngày phải đi làm: thứ Hai–thứ Bảy, không phải ngày lễ. */
export function isWorkday(d: Date, holidays: Set<string>) {
  return !isSunday(d) && !holidays.has(bizDateStr(d));
}

/** Số ngày nghỉ của một đơn: ngày làm việc trong [from, to]. */
export function countLeaveDays(from: Date, to: Date, holidays: Set<string>): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkday(d, holidays)) n++;
  return n;
}

export const CELL_VALUES = ["1", "0.5", "0"] as const;

/**
 * Ô lưới tên `a_<employeeId>_<YYYY-MM-DD>`, giá trị "1" | "0.5" | "0" | "" (trống = xoá chấm công ngày đó).
 * Chỉ nhận ô của người và ngày đang hiển thị.
 */
export function parseAttendanceForm(f: FormData, employeeIds: string[], days: Date[]) {
  const ids = new Set(employeeIds);
  const daySet = new Set(days.map(bizDateStr));
  const upserts: { employeeId: string; date: Date; value: number }[] = [];
  const clears: { employeeId: string; date: Date }[] = [];
  for (const [key, raw] of f.entries()) {
    const m = /^a_(.+)_(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!m || !ids.has(m[1]) || !daySet.has(m[2])) continue;
    const v = String(raw).trim();
    const date = parseBizDate(m[2]);
    if (v === "") clears.push({ employeeId: m[1], date });
    else if ((CELL_VALUES as readonly string[]).includes(v)) upserts.push({ employeeId: m[1], date, value: Number(v) });
    else throw new Error(`Giá trị chấm công không hợp lệ: ${v}`);
  }
  return { upserts, clears };
}

/** Kỳ lương tháng đã duyệt trở đi thì chấm công / ngày lễ / đơn nghỉ tháng đó bị khoá. */
export async function assertMonthOpen(tx: Tx, year: number, month: number) {
  const p = await tx.payrollPeriod.findUnique({ where: { year_month: { year, month } } });
  if (p && p.status !== "DRAFT" && p.status !== "CALCULATED") {
    throw new Error(`Kỳ lương ${month}/${year} đã ${p.status} — không sửa được chấm công tháng này`);
  }
}

export async function saveAttendance(
  tx: Tx,
  p: { year: number; month: number; upserts: { employeeId: string; date: Date; value: number }[]; clears: { employeeId: string; date: Date }[]; actorId: string },
) {
  await assertMonthOpen(tx, p.year, p.month);
  for (const u of p.upserts) {
    await tx.attendanceDay.upsert({
      where: { employeeId_date: { employeeId: u.employeeId, date: u.date } },
      create: { employeeId: u.employeeId, date: u.date, value: u.value, approvedBy: p.actorId },
      update: { value: u.value, approvedBy: p.actorId },
    });
  }
  for (const c of p.clears) await tx.attendanceDay.deleteMany({ where: { employeeId: c.employeeId, date: c.date } });
  await audit(tx, {
    actorId: p.actorId,
    tableName: "AttendanceDay",
    recordId: `${p.year}-${p.month}`,
    action: "UPDATE",
    after: { upserts: p.upserts.length, clears: p.clears.length },
  });
}

// ------------------------------------------------------------- nghỉ phép

/** Số dư phép năm: tạo từ LeaveType.daysPerYear nếu chưa có. Loại không giới hạn (null) → null. */
export async function ensureBalance(tx: Tx, employeeId: string, leaveTypeId: string, year: number) {
  const lt = await tx.leaveType.findUniqueOrThrow({ where: { id: leaveTypeId } });
  if (lt.daysPerYear === null) return null;
  return tx.leaveBalance.upsert({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    create: { employeeId, leaveTypeId, year, entitled: lt.daysPerYear },
    update: {},
  });
}

export async function createLeave(
  tx: Tx,
  p: { employeeId: string; leaveTypeId: string; fromDate: Date; toDate: Date; days?: number | null; reason?: string | null; actorId: string },
) {
  if (p.toDate < p.fromDate) throw new Error("Ngày kết thúc phải sau ngày bắt đầu");
  if (p.fromDate.getUTCFullYear() !== p.toDate.getUTCFullYear()) throw new Error("Đơn nghỉ không vắt qua năm — tách làm hai đơn");
  const hol = new Set((await tx.holiday.findMany({ where: { date: { gte: p.fromDate, lte: p.toDate } } })).map((h) => bizDateStr(h.date)));
  const auto = countLeaveDays(p.fromDate, p.toDate, hol);
  const days = p.days ?? auto;
  if (!(days > 0) || days > auto || Math.round(days * 2) !== days * 2) {
    throw new Error(`Số ngày nghỉ phải từ 0,5 đến ${auto} (số ngày làm việc trong khoảng), bước 0,5`);
  }
  const req = await tx.leaveRequest.create({
    data: { employeeId: p.employeeId, leaveTypeId: p.leaveTypeId, fromDate: p.fromDate, toDate: p.toDate, days, reason: p.reason ?? null },
  });
  await audit(tx, { actorId: p.actorId, tableName: "LeaveRequest", recordId: req.id, action: "CREATE", after: req });
  return req;
}

/** Duyệt: trừ số dư phép (nếu loại có định mức), không cho âm. */
export async function approveLeave(tx: Tx, p: { id: string; actorId: string }) {
  const req = await tx.leaveRequest.findUniqueOrThrow({ where: { id: p.id } });
  if (req.status !== "PENDING") throw new Error("Đơn không còn chờ duyệt");
  await assertMonthOpen(tx, req.fromDate.getUTCFullYear(), req.fromDate.getUTCMonth() + 1);
  const bal = await ensureBalance(tx, req.employeeId, req.leaveTypeId, req.fromDate.getUTCFullYear());
  if (bal) {
    const remaining = Number(bal.entitled) - Number(bal.used);
    if (Number(req.days) > remaining) throw new Error(`Không đủ phép: còn ${remaining} ngày, đơn ${Number(req.days)} ngày`);
    await tx.leaveBalance.update({ where: { id: bal.id }, data: { used: Number(bal.used) + Number(req.days) } });
  }
  const after = await tx.leaveRequest.update({ where: { id: p.id }, data: { status: "APPROVED", approvedBy: p.actorId } });
  await audit(tx, { actorId: p.actorId, tableName: "LeaveRequest", recordId: p.id, action: "UPDATE", before: req, after });
  return after;
}

/** Từ chối đơn chờ duyệt, hoặc huỷ đơn đã duyệt (hoàn lại số dư phép). */
export async function rejectLeave(tx: Tx, p: { id: string; actorId: string }) {
  const req = await tx.leaveRequest.findUniqueOrThrow({ where: { id: p.id } });
  if (req.status === "REJECTED") throw new Error("Đơn đã bị từ chối/huỷ");
  if (req.status === "APPROVED") {
    await assertMonthOpen(tx, req.fromDate.getUTCFullYear(), req.fromDate.getUTCMonth() + 1);
    const bal = await ensureBalance(tx, req.employeeId, req.leaveTypeId, req.fromDate.getUTCFullYear());
    if (bal) await tx.leaveBalance.update({ where: { id: bal.id }, data: { used: Math.max(0, Number(bal.used) - Number(req.days)) } });
  }
  const after = await tx.leaveRequest.update({ where: { id: p.id }, data: { status: "REJECTED", approvedBy: p.actorId } });
  await audit(tx, { actorId: p.actorId, tableName: "LeaveRequest", recordId: p.id, action: "UPDATE", before: req, after });
  return after;
}
