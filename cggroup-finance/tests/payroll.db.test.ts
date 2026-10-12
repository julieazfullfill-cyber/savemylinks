// Test tích hợp GĐ2 với Postgres thật (schema tạm, xem global-setup.ts).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { addDays, parseBizDate as d } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { addContract } from "@/lib/hr";
import { approvePeriod, calculatePeriod, createPeriod, salaryAt, suggestStandardDays } from "@/lib/payroll-service";
import { seedCatalog } from "../prisma/seed-data";
import { seedPhase2 } from "../prisma/seed-phase2";

const actorId = "test";
const ids: Record<string, string> = {};

const contract = (employeeId: string, from: string, base: bigint, extra: Partial<{ allowanceVnd: bigint; dependents: number }> = {}) =>
  prisma.$transaction((tx) =>
    addContract(tx, {
      employeeId, effectiveFrom: d(from), baseSalaryVnd: base,
      allowanceVnd: extra.allowanceVnd ?? 0n, mealVnd: 0n, transportVnd: 0n, dutyVnd: 0n,
      insuranceSalaryVnd: base, dependents: extra.dependents ?? 0, actorId,
    }),
  );

/** n ngày thứ Hai–thứ Bảy đầu tiên của tháng 8/2026. */
function augWorkdays(n: number): Date[] {
  const out: Date[] = [];
  for (let x = d("2026-08-01"); out.length < n; x = addDays(x, 1)) if (x.getUTCDay() !== 0) out.push(x);
  return out;
}

beforeAll(async () => {
  await seedCatalog(prisma);
  await seedPhase2(prisma);
  for (const [code, fullName, joined] of [
    ["NV01", "Dương Thành Công", "2025-01-01"],
    ["NV15", "Lê Thị Thảo", "2025-06-01"],
    ["NV23", "Đỗ Xuân Thành", "2026-08-01"],
  ] as const) {
    ids[code] = (await prisma.employee.create({ data: { code, fullName, joinedAt: d(joined), status: "OFFICIAL" } })).id;
  }
});

afterAll(() => prisma.$disconnect());

describe("hợp đồng", () => {
  it("tăng lương = hợp đồng mới, hợp đồng cũ tự đóng hôm trước; tra được lương từng tháng", async () => {
    await contract(ids.NV01, "2025-01-01", 18_000_000n);
    await contract(ids.NV01, "2026-08-01", 20_000_000n);
    const all = await prisma.employmentContract.findMany({ where: { employeeId: ids.NV01 }, orderBy: { effectiveFrom: "asc" } });
    expect(all[0].effectiveTo).toEqual(d("2026-07-31"));
    expect(all[1].effectiveTo).toBeNull();

    const jul = await prisma.$transaction((tx) => salaryAt(tx, 2026, 7));
    const aug = await prisma.$transaction((tx) => salaryAt(tx, 2026, 8));
    expect(jul.find((r) => r.employee.code === "NV01")?.contract?.baseSalaryVnd).toBe(18_000_000n);
    expect(aug.find((r) => r.employee.code === "NV01")?.contract?.baseSalaryVnd).toBe(20_000_000n);
  });

  it("không chèn hợp đồng vào quá khứ", async () => {
    await expect(contract(ids.NV01, "2026-01-01", 1n)).rejects.toThrow(/phải sau hợp đồng gần nhất/);
  });

  it("DB chặn sửa đè số tiền, chặn xoá, chặn hai hợp đồng chồng nhau", async () => {
    const c = await prisma.employmentContract.findFirstOrThrow({ where: { employeeId: ids.NV01, effectiveTo: null } });
    await expect(prisma.employmentContract.update({ where: { id: c.id }, data: { baseSalaryVnd: 99n } })).rejects.toThrow(/khong duoc sua de/);
    await expect(prisma.employmentContract.delete({ where: { id: c.id } })).rejects.toThrow(/Khong duoc xoa/);
    await expect(
      prisma.employmentContract.create({ data: { employeeId: ids.NV01, effectiveFrom: d("2026-09-01"), baseSalaryVnd: 1n } }),
    ).rejects.toThrow(/contract_no_overlap/);
  });
});

describe("kỳ lương tháng 8/2026", () => {
  let periodId = "";

  beforeAll(async () => {
    await contract(ids.NV15, "2025-06-01", 11_000_000n, { allowanceVnd: 1_100_000n });
    // NV01: 23 ngày công + 1 ngày phép năm (có lương). NV15: 22 ngày. NV23: chưa có hợp đồng.
    const att = [
      ...augWorkdays(23).map((date) => ({ employeeId: ids.NV01, date, value: 1 })),
      ...augWorkdays(22).map((date) => ({ employeeId: ids.NV15, date, value: 1 })),
    ];
    await prisma.attendanceDay.createMany({ data: att });
    const phep = await prisma.leaveType.findUniqueOrThrow({ where: { code: "PHEP_NAM" } });
    await prisma.leaveRequest.create({
      data: { employeeId: ids.NV01, leaveTypeId: phep.id, fromDate: d("2026-08-28"), toDate: d("2026-08-28"), days: 1, status: "APPROVED" },
    });
    await prisma.kpiResult.create({
      data: {
        employeeId: ids.NV15, year: 2026, month: 8, cashReceivedUsd: 0, ffCostUsd: 0, profitUsd: 0,
        targetUsd: 0, achievedPct: 0, bonusVnd: 53_623_000n,
      },
    });
    periodId = (
      await prisma.$transaction((tx) =>
        createPeriod(tx, { year: 2026, month: 8, standardDays: 24, companyProfitVnd: -3_475n * 26_060n, actorId }),
      )
    ).id;
  });

  it("gợi ý ngày công chuẩn: thứ Hai–thứ Bảy trừ lễ", () => {
    expect(suggestStandardDays(2026, 8, [])).toBe(26);
    expect(suggestStandardDays(2026, 9, [d("2026-09-02")])).toBe(25);
  });

  it("thiếu hợp đồng → báo tên người, không bỏ sót lặng lẽ", async () => {
    await expect(prisma.$transaction((tx) => calculatePeriod(tx, periodId, actorId))).rejects.toThrow(/NV23 Đỗ Xuân Thành/);
  });

  it("tính kỳ: phép có lương được tính công, thưởng tháng lỗ bị giữ, tổng = cộng dòng", async () => {
    await contract(ids.NV23, "2026-08-01", 10_000_000n, { allowanceVnd: 1_100_000n });
    // NV23 vào làm 01/08 nhưng chưa chấm công ngày nào → lương cứng 0, vẫn có dòng.
    const r = await prisma.$transaction((tx) => calculatePeriod(tx, periodId, actorId));
    expect(r.period.status).toBe("CALCULATED");
    expect(r.usingDefaults).toEqual([]);

    const lines = await prisma.payrollLine.findMany({ where: { periodId }, include: { employee: true } });
    const by = Object.fromEntries(lines.map((l) => [l.employee.code, l]));
    expect(Object.keys(by).sort()).toEqual(["NV01", "NV15", "NV23"]);

    expect(Number(by.NV01.workedDays)).toBe(23);
    expect(Number(by.NV01.leaveDays)).toBe(1);
    expect(by.NV01.proratedVnd).toBe(20_000_000n);
    expect(by.NV01.netVnd).toBe(17_460_000n);

    expect(by.NV15.proratedVnd).toBe(10_083_333n);
    expect(by.NV15.salesBonusVnd).toBe(0n);
    expect(by.NV15.bonusHeldVnd).toBe(53_623_000n);
    expect(by.NV15.netVnd).toBe(10_028_333n);
    expect(by.NV15.note).toMatch(/giữ lại/);

    expect(r.totals.netVnd).toBe(lines.reduce((a, l) => a + l.netVnd, 0n));
  });

  it("duyệt: sinh bút toán lương cân ngày cuối tháng, rồi khoá kỳ", async () => {
    const r = await prisma.$transaction((tx) => approvePeriod(tx, periodId, actorId));
    const j = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.journalId }, include: { lines: true } });
    expect(j.date).toEqual(d("2026-08-31"));
    expect(j.source).toBe("PAYROLL");
    const debit = j.lines.reduce((a, l) => a + l.debitVnd, 0n);
    const credit = j.lines.reduce((a, l) => a + l.creditVnd, 0n);
    expect(debit).toBe(credit);
    expect(debit).toBe(r.totals.companyCostVnd);
    expect(j.lines.find((l) => l.accountCode === "202")?.creditVnd).toBe(r.totals.netVnd);

    await expect(prisma.$transaction((tx) => calculatePeriod(tx, periodId, actorId))).rejects.toThrow(/APPROVED/);
    const line = await prisma.payrollLine.findFirstOrThrow({ where: { periodId } });
    await expect(prisma.payrollLine.update({ where: { id: line.id }, data: { netVnd: 1n } })).rejects.toThrow(/khong duoc thay doi/);
    await expect(prisma.payrollPeriod.delete({ where: { id: periodId } })).rejects.toThrow(/khong duoc xoa/);
  });
});

describe("chốt chặn GĐ2 khác", () => {
  it("chấm công chỉ nhận 0 / 0,5 / 1", async () => {
    await expect(prisma.attendanceDay.create({ data: { employeeId: ids.NV01, date: d("2026-09-01"), value: 0.7 } })).rejects.toThrow(
      /attendance_value/,
    );
  });
});
