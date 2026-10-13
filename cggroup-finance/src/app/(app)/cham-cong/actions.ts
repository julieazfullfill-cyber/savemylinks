"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertMonthOpen, monthDays, parseAttendanceForm, saveAttendance } from "@/lib/attendance";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { parseBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";

const HR = ["ADMIN", "QUAN_LY"] as const;
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

export async function saveGrid(year: number, month: number, employeeIds: string[], form: FormData) {
  const me = await requireUser([...HR]);
  try {
    const { upserts, clears } = parseAttendanceForm(form, employeeIds, monthDays(year, month));
    await prisma.$transaction((tx) => saveAttendance(tx, { year, month, upserts, clears, actorId: me.uid }), { timeout: 30_000 });
  } catch (e) {
    return redirect(`/cham-cong?thang=${ym(year, month)}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/cham-cong");
  redirect(`/cham-cong?thang=${ym(year, month)}&ok=${encodeURIComponent("Đã lưu chấm công")}`);
}

export async function addHoliday(thang: string, form: FormData) {
  const me = await requireUser([...HR]);
  try {
    const date = parseBizDate(String(form.get("date") ?? ""));
    const name = String(form.get("name") ?? "").trim();
    if (!name) throw new Error("Thiếu tên ngày lễ");
    await prisma.$transaction(async (tx) => {
      await assertMonthOpen(tx, date.getUTCFullYear(), date.getUTCMonth() + 1);
      const h = await tx.holiday.upsert({ where: { date }, create: { date, name, paid: form.get("paid") === "on" }, update: { name, paid: form.get("paid") === "on" } });
      await audit(tx, { actorId: me.uid, tableName: "Holiday", recordId: String(form.get("date")), action: "CREATE", after: h });
    });
  } catch (e) {
    return redirect(`/cham-cong?thang=${thang}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/cham-cong");
  redirect(`/cham-cong?thang=${thang}&ok=${encodeURIComponent("Đã lưu ngày lễ")}`);
}

export async function removeHoliday(thang: string, dateStr: string) {
  const me = await requireUser([...HR]);
  try {
    const date = parseBizDate(dateStr);
    await prisma.$transaction(async (tx) => {
      await assertMonthOpen(tx, date.getUTCFullYear(), date.getUTCMonth() + 1);
      const before = await tx.holiday.delete({ where: { date } });
      await audit(tx, { actorId: me.uid, tableName: "Holiday", recordId: dateStr, action: "VOID", before });
    });
  } catch (e) {
    return redirect(`/cham-cong?thang=${thang}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/cham-cong");
  redirect(`/cham-cong?thang=${thang}&ok=${encodeURIComponent("Đã bỏ ngày lễ")}`);
}
