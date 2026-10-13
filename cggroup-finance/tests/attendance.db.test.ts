import { vi } from "vitest";

// Schema riêng của file này (xem tests/global-setup.ts) — phải chạy trước khi Prisma kết nối.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DB_URL_ATTENDANCE;
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveLeave, createLeave, rejectLeave, saveAttendance } from "@/lib/attendance";
import { parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { seedPhase2 } from "../prisma/seed-phase2";

let emp = "";
let phep = "";

beforeAll(async () => {
  await seedPhase2(prisma);
  emp = (await prisma.employee.create({ data: { code: "NV01", fullName: "A", joinedAt: d("2026-01-01") } })).id;
  phep = (await prisma.leaveType.findUniqueOrThrow({ where: { code: "PHEP_NAM" } })).id;
});
afterAll(() => prisma.$disconnect());

describe("nghỉ phép", () => {
  it("duyệt trừ phép; không đủ phép thì chặn; huỷ đơn đã duyệt hoàn phép", async () => {
    const r1 = await prisma.$transaction((tx) =>
      createLeave(tx, { employeeId: emp, leaveTypeId: phep, fromDate: d("2026-12-21"), toDate: d("2026-12-26"), actorId: "nv" }),
    );
    expect(Number(r1.days)).toBe(6);
    await prisma.$transaction((tx) => approveLeave(tx, { id: r1.id, actorId: "hr" }));
    const bal = () => prisma.leaveBalance.findFirstOrThrow({ where: { employeeId: emp, leaveTypeId: phep, year: 2026 } });
    expect(Number((await bal()).used)).toBe(6);

    const r2 = await prisma.$transaction((tx) =>
      createLeave(tx, { employeeId: emp, leaveTypeId: phep, fromDate: d("2026-12-01"), toDate: d("2026-12-08"), actorId: "nv" }),
    ); // 7 ngày, còn 6
    await expect(prisma.$transaction((tx) => approveLeave(tx, { id: r2.id, actorId: "hr" }))).rejects.toThrow(/Không đủ phép: còn 6/);

    await prisma.$transaction((tx) => rejectLeave(tx, { id: r1.id, actorId: "hr" }));
    expect(Number((await bal()).used)).toBe(0);
  });

  it("nửa ngày hợp lệ, quá số ngày làm việc thì không", async () => {
    const half = await prisma.$transaction((tx) =>
      createLeave(tx, { employeeId: emp, leaveTypeId: phep, fromDate: d("2026-12-02"), toDate: d("2026-12-02"), days: 0.5, actorId: "nv" }),
    );
    expect(Number(half.days)).toBe(0.5);
    await expect(
      prisma.$transaction((tx) => createLeave(tx, { employeeId: emp, leaveTypeId: phep, fromDate: d("2026-12-06"), toDate: d("2026-12-06"), actorId: "nv" })),
    ).rejects.toThrow(/từ 0,5 đến 0/); // chủ nhật
  });
});

describe("chấm công", () => {
  it("lưu, xoá ô; khoá khi kỳ lương đã duyệt", async () => {
    await prisma.$transaction((tx) =>
      saveAttendance(tx, { year: 2026, month: 11, upserts: [{ employeeId: emp, date: d("2026-11-02"), value: 1 }], clears: [], actorId: "hr" }),
    );
    expect(await prisma.attendanceDay.count({ where: { employeeId: emp } })).toBe(1);
    await prisma.$transaction((tx) =>
      saveAttendance(tx, { year: 2026, month: 11, upserts: [], clears: [{ employeeId: emp, date: d("2026-11-02") }], actorId: "hr" }),
    );
    expect(await prisma.attendanceDay.count({ where: { employeeId: emp } })).toBe(0);

    await prisma.payrollPeriod.create({ data: { year: 2026, month: 11, standardDays: 24, status: "APPROVED" } });
    await expect(
      prisma.$transaction((tx) => saveAttendance(tx, { year: 2026, month: 11, upserts: [{ employeeId: emp, date: d("2026-11-03"), value: 1 }], clears: [], actorId: "hr" })),
    ).rejects.toThrow(/đã APPROVED/);
  });
});
