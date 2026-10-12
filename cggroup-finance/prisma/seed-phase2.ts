// Danh mục khởi tạo GĐ2 — đặc tả GĐ2 mục 08. Idempotent.
// Được seed.ts gọi; chạy riêng: npx tsx prisma/seed-phase2.ts
import { PrismaClient } from "@prisma/client";
import { INSURANCE_DEFAULT, MEAL_EXEMPT_CAP_VND } from "../src/lib/payroll";
import { PIT_DEFAULT } from "../src/lib/pit";

export const departments: [string, string][] = [
  ["VANHANH", "Vận hành POD"],
  ["THIETKE", "Thiết kế"],
  ["MKT", "Marketing"],
  ["KETOAN", "Kế toán"],
  ["HANHCHINH", "Hành chính - Nhân sự"],
  ["TIKTOK", "TikTok"],
];

export const positions: [string, string][] = [
  ["SELLER", "Nhân viên bán hàng"],
  ["DESIGNER", "Thiết kế"],
  ["LEAD", "Trưởng nhóm"],
  ["KETOAN", "Kế toán"],
  ["HANHCHINH", "Hành chính"],
  ["SUPPORT", "Hỗ trợ vận hành"],
];

export const leaveTypes: [string, string, boolean, number | null][] = [
  ["PHEP_NAM", "Phép năm", true, 12],
  ["KHONG_LUONG", "Nghỉ không lương", false, null],
  ["OM", "Nghỉ ốm", true, null],
  ["VIEC_RIENG", "Việc riêng", false, null],
];

// Bậc thưởng theo % đạt KPI — chỉnh lại theo chính sách thật
export const bonusTiers = [
  { name: "80–100%", fromPct: 80, toPct: 100, ratePct: 0 },
  { name: "100–120%", fromPct: 100, toPct: 120, ratePct: 2 },
  { name: "120–150%", fromPct: 120, toPct: 150, ratePct: 3 },
  { name: "trên 150%", fromPct: 150, toPct: null, ratePct: 4 },
];

export async function seedPhase2(db: PrismaClient) {
  for (const [code, name] of departments) {
    await db.department.upsert({ where: { code }, update: { name }, create: { code, name } });
  }
  for (const [code, name] of positions) {
    await db.position.upsert({ where: { code }, update: { name }, create: { code, name } });
  }
  for (const [code, name, paid, daysPerYear] of leaveTypes) {
    await db.leaveType.upsert({ where: { code }, update: { name, paid, daysPerYear }, create: { code, name, paid, daysPerYear } });
  }
  for (const t of bonusTiers) {
    const existing = await db.bonusRule.findFirst({ where: { name: t.name } });
    if (!existing) await db.bonusRule.create({ data: t });
  }

  // Tham số BHXH/TNCN nằm trong DB để đổi được không cần sửa code.
  // CẦN KẾ TOÁN XÁC NHẬN trước kỳ lương thật đầu tiên. `update: {}` — không ghi đè số kế toán đã sửa.
  const settings = [
    { key: "pit", valueJson: PIT_DEFAULT, note: "Giảm trừ gia cảnh và bậc thuế — kế toán xác nhận mức hiện hành" },
    { key: "insurance", valueJson: INSURANCE_DEFAULT, note: "Tỷ lệ BHXH/BHYT/BHTN — kế toán xác nhận" },
    { key: "mealExemptCap", valueJson: { vnd: MEAL_EXEMPT_CAP_VND }, note: "Trần phụ cấp ăn miễn thuế — kế toán xác nhận" },
  ];
  for (const s of settings) {
    await db.payrollSetting.upsert({
      where: { key: s.key },
      update: {},
      create: { key: s.key, valueJson: s.valueJson as object, note: s.note },
    });
  }
  return { departments: departments.length, positions: positions.length, leaveTypes: leaveTypes.length, bonusTiers: bonusTiers.length };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("prisma/seed-phase2.ts")) {
  const db = new PrismaClient();
  seedPhase2(db)
    .then((n) => console.log(`Seed GĐ2 xong: ${n.departments} phòng ban, ${n.positions} chức danh, ${n.leaveTypes} loại phép, ${n.bonusTiers} bậc thưởng.`))
    .finally(() => db.$disconnect());
}
