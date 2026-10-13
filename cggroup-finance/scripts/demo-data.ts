// Dữ liệu mẫu để thử toàn bộ hệ thống — CHỈ chạy trên DB/schema thử (tên có "demo" hoặc "test").
//   DATABASE_URL=...cggroup_finance_test?schema=demo npx tsx scripts/demo-data.ts
// Tạo qua chính các hàm nghiệp vụ nên bút toán, công nợ, kỳ lương đều đúng như dùng thật.
import { PrismaClient, type Employee } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seedCatalog } from "../prisma/seed-data";
import { seedPhase2 } from "../prisma/seed-phase2";
import { approveLeave, createLeave, saveAttendance } from "../src/lib/attendance";
import { addDays, dayOfMonth, startOfWeek, todayVn } from "../src/lib/dates";
import { approveExpense, createExpense, payExpense } from "../src/lib/expenses";
import { buildForecast } from "../src/lib/forecast";
import { loadForecastInput } from "../src/lib/forecast-data";
import { addContract } from "../src/lib/hr";
import { saveKpiMonth } from "../src/lib/kpi-service";
import { postCashTxn } from "../src/lib/ledger";
import { createBill, payBill } from "../src/lib/payables";
import { approvePeriod, calculatePeriod, createPeriod, payPeriod, setAdjustment } from "../src/lib/payroll-service";
import { toJsonSafe } from "../src/lib/db";

const url = process.env.DATABASE_URL ?? "";
if (!/demo|test/i.test(url)) {
  console.error("Từ chối: DATABASE_URL phải trỏ tới DB/schema thử (có chữ demo hoặc test).");
  process.exit(1);
}
const db = new PrismaClient();
const A = "demo";

async function main() {
  await seedCatalog(db);
  await seedPhase2(db);
  if (!(await db.user.findUnique({ where: { email: "admin@cggroup.local" } }))) {
    await db.user.create({ data: { email: "admin@cggroup.local", name: "Admin", role: "ADMIN", passwordHash: await bcrypt.hash("doi-mat-khau-ngay", 10) } });
  }
  const today = todayVn();
  const d0 = addDays(today, -95);
  const id = async (code: string) => (await db.cashAccount.findUniqueOrThrow({ where: { code } })).id;
  const [bank, awhk] = [await id("BANKVN"), await id("AWHK")];
  const po = await db.cashAccount.create({
    data: { code: "PO-SALES01", name: "Payoneer sales", providerId: "prov_payoneer", email: "sales01@cggroup.vn", kind: "EWALLET", currency: "USD", glAccount: "107" },
  });

  for (let i = 0; i <= 95; i += 3) {
    await db.fxRate.create({ data: { date: addDays(d0, i), base: "USD", quote: "VND", rate: String(25_250 + (i % 9) * 15) } });
  }
  const shops = await Promise.all(
    [
      ["AMZ-AU1", "Amazon AU1", "AMAZON"],
      ["AMZ-SHH", "Amazon SHH", "AMAZON"],
      ["ET-01", "Etsy Wedding", "ETSY"],
      ["WM-01", "Walmart 01", "WALMART"],
      ["TT-01", "TikTok 01", "TIKTOK"],
    ].map(([code, name, channel]) => db.shop.create({ data: { code, name, channel } })),
  );
  const cat = async (code: string) => (await db.expenseCategory.findUniqueOrThrow({ where: { code } })).id;
  await db.expenseCategory.update({ where: { code: "THUE_VP" }, data: { dueDay: 5, budgetVnd: 25_000_000n } });
  await db.expenseCategory.update({ where: { code: "VPS_TOOL" }, data: { dueDay: 15, budgetVnd: 8_000_000n } });
  await db.supplier.update({ where: { code: "MERCHIZE" }, data: { prepaid: false, creditDays: 15 } });

  await db.$transaction(
    async (tx) => {
      await postCashTxn(tx, { date: d0, accountId: bank, direction: "IN", opening: true, amount: 800_000_000n, description: "Số dư đầu kỳ", actorId: A });
      await postCashTxn(tx, { date: d0, accountId: awhk, direction: "IN", opening: true, amount: 2_500_000n, description: "Số dư đầu kỳ", actorId: A });
      await postCashTxn(tx, { date: d0, accountId: po.id, direction: "IN", opening: true, amount: 800_000n, description: "Số dư đầu kỳ", actorId: A });
      for (let i = 2, n = 0; i <= 93; i += 7, n++) {
        const s = shops[n % shops.length];
        await postCashTxn(tx, { date: addDays(d0, i), accountId: n % 2 ? po.id : awhk, direction: "IN", shopIncome: true, shopId: s.id, amount: BigInt(900_000 + n * 40_000), description: `Payout ${s.code}`, actorId: A });
        await postCashTxn(tx, { date: addDays(d0, i + 1), accountId: awhk, direction: "OUT", categoryId: await cat("FULFILL"), amount: 350_000n, description: "Nạp fulfill trả trước", actorId: A });
      }
      for (let k = 0; k < 3; k++) {
        await postCashTxn(tx, { date: addDays(d0, 20 + k * 30), accountId: bank, direction: "OUT", categoryId: await cat("THUE_VP"), amount: 25_000_000n, description: "Thuê văn phòng", actorId: A });
      }
      const sup = await db.supplier.findUniqueOrThrow({ where: { code: "MERCHIZE" } });
      const b1 = await createBill(tx, { supplierId: sup.id, billNo: "MZ-1001", issueDate: addDays(today, -40), amount: 420_000n, currency: "USD", actorId: A });
      await payBill(tx, { billId: b1.id, accountId: awhk, date: addDays(today, -20), amount: 200_000n, actorId: A });
      await createBill(tx, { supplierId: sup.id, billNo: "MZ-1002", issueDate: addDays(today, -10), amount: 380_000n, currency: "USD", actorId: A });
      const e1 = await createExpense(tx, { date: addDays(today, -6), categoryId: await cat("VPS_TOOL"), amount: 9_500_000n, currency: "VND", description: "Gia hạn VPS + tool", requestedBy: A });
      await approveExpense(tx, { id: e1.id, actorId: "gd", actorRole: "QUAN_LY" });
      await payExpense(tx, { id: e1.id, accountId: bank, date: addDays(today, -5), actorId: A });
      await createExpense(tx, { date: addDays(today, -1), categoryId: await cat("MARKETING"), amount: 15_000_000n, currency: "VND", description: "Booking influencer", requestedBy: "nv" });
      await tx.accountBalance.create({ data: { accountId: awhk, date: addDays(today, -1), available: 1_000_000n, reserved: 300_000n, releaseOn: addDays(today, 12) } });
      await tx.forecastItem.create({ data: { expectedOn: addDays(today, 25), direction: "OUT", amountVnd: 60_000_000n, label: "Nộp thuế quý" } });
    },
    { timeout: 120_000 },
  );

  // Nhân sự + lương tháng trước
  const prev = today.getUTCMonth() === 0 ? { y: today.getUTCFullYear() - 1, m: 12 } : { y: today.getUTCFullYear(), m: today.getUTCMonth() };
  const people = [
    ["NV01", "Dương Thành Công", 20_000_000n, 0n],
    ["NV03", "Luyện Thành Trung", 11_500_000n, 1_100_000n],
    ["NV08", "Nguyễn Đào Diệu My", 9_000_000n, 1_100_000n],
    ["NV15", "Lê Thị Thảo", 11_000_000n, 1_100_000n],
  ] as const;
  const dept = await db.department.findUniqueOrThrow({ where: { code: "VANHANH" } });
  const emps: Employee[] = [];
  for (const [code, fullName, base, allow] of people) {
    const e = await db.employee.create({ data: { code, fullName, joinedAt: dayOfMonth(prev.y - 1, 0, 1), status: "OFFICIAL", departmentId: dept.id, workMode: code === "NV08" ? "ONLINE" : "OFFICE" } });
    await db.$transaction((tx) => addContract(tx, { employeeId: e.id, effectiveFrom: dayOfMonth(prev.y - 1, 0, 1), baseSalaryVnd: base, allowanceVnd: allow, mealVnd: 0n, transportVnd: 0n, dutyVnd: 0n, insuranceSalaryVnd: base, dependents: 0, actorId: A }));
    emps.push(e);
  }
  const days: Date[] = [];
  for (let x = dayOfMonth(prev.y, prev.m - 1, 1); x <= dayOfMonth(prev.y, prev.m - 1, 31); x = addDays(x, 1)) if (x.getUTCDay() !== 0) days.push(x);
  await db.$transaction((tx) =>
    saveAttendance(tx, { year: prev.y, month: prev.m, upserts: emps.flatMap((e, i) => days.slice(0, 24 - i).map((date) => ({ employeeId: e.id, date, value: 1 }))), clears: [], actorId: A }),
  );
  const phep = await db.leaveType.findUniqueOrThrow({ where: { code: "PHEP_NAM" } });
  const lv = await db.$transaction((tx) => createLeave(tx, { employeeId: emps[2].id, leaveTypeId: phep.id, fromDate: days[22], toDate: days[22], actorId: A }));
  await db.$transaction((tx) => approveLeave(tx, { id: lv.id, actorId: A }));
  await db.$transaction((tx) =>
    saveKpiMonth(tx, {
      year: prev.y,
      month: prev.m,
      overheadTotalUsd: 3000,
      rows: [
        { employeeId: emps[3].id, targetUsd: 4000, shopIds: [shops[0].id], cashReceivedUsd: 12000, ffCostUsd: 4200 },
        { employeeId: emps[1].id, targetUsd: 3000, shopIds: [shops[2].id], cashReceivedUsd: 5000, ffCostUsd: 1800 },
      ],
      actorId: A,
    }),
  );
  const period = await db.$transaction((tx) => createPeriod(tx, { year: prev.y, month: prev.m, standardDays: 24, companyProfitVnd: -87_000_000n, actorId: A }));
  await db.$transaction((tx) => setAdjustment(tx, { periodId: period.id, employeeId: emps[0].id, perfPayVnd: 1_000_000n, penaltyVnd: 0n, note: "Hiệu quả quản lý", actorId: A }));
  await db.$transaction((tx) => calculatePeriod(tx, period.id, A));
  await db.$transaction((tx) => approvePeriod(tx, period.id, "gd"));
  await db.$transaction((tx) => payPeriod(tx, { periodId: period.id, accountId: bank, date: addDays(today, -8), actorId: A }));

  const start = startOfWeek(today);
  const { input } = await db.$transaction((tx) => loadForecastInput(tx, { startDate: start }));
  await db.forecastSnapshot.create({
    data: { weekStart: start, scenario: { name: "Cơ sở", revenueFactor: 1, ffRate: input.scenario.ffRate, floorVnd: "400000000" }, rows: toJsonSafe(buildForecast(input)) as object, createdBy: A },
  });
  console.log("Đã tạo dữ liệu mẫu.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
