// Đọc tham số BHXH/TNCN từ bảng PayrollSetting (đặc tả GĐ2 mục 12).
// Thiếu hoặc sai định dạng → dùng giá trị khởi tạo nhưng báo `usingDefaults` để UI cảnh báo.
import { z } from "zod";
import type { Tx } from "./db";
import { INSURANCE_DEFAULT, MEAL_EXEMPT_CAP_VND, type InsuranceConfig } from "./payroll";
import { PIT_DEFAULT, type PitConfig } from "./pit";

const rate = z.number().min(0).max(1);
const pitSchema = z.object({
  personalVnd: z.number().int().nonnegative(),
  dependentVnd: z.number().int().nonnegative(),
  brackets: z
    .array(z.object({ upToVnd: z.number().int().positive().nullable(), rate }))
    .min(1)
    .refine((b) => b[b.length - 1].upToVnd === null, "Bậc cuối phải có upToVnd = null"),
});
const insuranceSchema = z.object({ employeeRate: rate, companyRate: rate });
const mealSchema = z.object({ vnd: z.number().int().nonnegative() });

export type PayrollSettings = {
  pit: PitConfig;
  insurance: InsuranceConfig;
  mealExemptCapVnd: number;
  /** key nào đang dùng giá trị khởi tạo (chưa có trong DB hoặc sai định dạng) */
  usingDefaults: string[];
};

export async function loadPayrollSettings(tx: Tx): Promise<PayrollSettings> {
  const rows = new Map((await tx.payrollSetting.findMany()).map((r) => [r.key, r.valueJson]));
  const usingDefaults: string[] = [];
  function pick<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
    const r = schema.safeParse(rows.get(key));
    if (r.success) return r.data;
    usingDefaults.push(key);
    return fallback;
  }
  return {
    pit: pick("pit", pitSchema, PIT_DEFAULT),
    insurance: pick("insurance", insuranceSchema, INSURANCE_DEFAULT),
    mealExemptCapVnd: pick("mealExemptCap", mealSchema, { vnd: MEAL_EXEMPT_CAP_VND }).vnd,
    usingDefaults,
  };
}
