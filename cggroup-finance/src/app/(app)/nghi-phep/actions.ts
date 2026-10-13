"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { approveLeave, createLeave, rejectLeave } from "@/lib/attendance";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { parseBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";

const isHr = (role: string) => role === "ADMIN" || role === "QUAN_LY";
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown) => redirect(`/nghi-phep?error=${encodeURIComponent((e as Error).message)}`);

export async function createLeaveAction(form: FormData) {
  const me = await requireUser();
  try {
    // Nhân viên chỉ tạo đơn cho chính mình; HR tạo hộ được.
    const own = await prisma.employee.findUnique({ where: { userId: me.uid } });
    const employeeId = isHr(me.role) ? str(form, "employeeId") || own?.id : own?.id;
    if (!employeeId) throw new Error("Tài khoản chưa gắn với hồ sơ nhân sự — nhờ HR gắn ở màn 9");
    const days = str(form, "days");
    await prisma.$transaction((tx) =>
      createLeave(tx, {
        employeeId,
        leaveTypeId: str(form, "leaveTypeId"),
        fromDate: parseBizDate(str(form, "fromDate")),
        toDate: parseBizDate(str(form, "toDate") || str(form, "fromDate")),
        days: days ? Number(days.replace(",", ".")) : null,
        reason: str(form, "reason") || null,
        actorId: me.uid,
      }),
    );
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/nghi-phep");
  redirect(`/nghi-phep?ok=${encodeURIComponent("Đã gửi đơn nghỉ")}`);
}

export async function decideLeave(id: string, approve: boolean) {
  const me = await requireUser(["ADMIN", "QUAN_LY"]);
  try {
    await prisma.$transaction((tx) => (approve ? approveLeave(tx, { id, actorId: me.uid }) : rejectLeave(tx, { id, actorId: me.uid })));
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/nghi-phep");
  redirect(`/nghi-phep?ok=${encodeURIComponent(approve ? "Đã duyệt, đã trừ phép" : "Đã từ chối / huỷ đơn")}`);
}

export async function setEntitlement(form: FormData) {
  const me = await requireUser(["ADMIN", "QUAN_LY"]);
  try {
    const entitled = Number(str(form, "entitled").replace(",", "."));
    if (!(entitled >= 0 && entitled <= 60)) throw new Error("Số ngày phép 0–60");
    const key = { employeeId: str(form, "employeeId"), leaveTypeId: str(form, "leaveTypeId"), year: Number(str(form, "year")) };
    await prisma.$transaction(async (tx) => {
      const row = await tx.leaveBalance.upsert({
        where: { employeeId_leaveTypeId_year: key },
        create: { ...key, entitled },
        update: { entitled },
      });
      if (Number(row.used) > entitled) throw new Error(`Đã dùng ${Number(row.used)} ngày — không đặt định mức thấp hơn`);
      await audit(tx, { actorId: me.uid, tableName: "LeaveBalance", recordId: row.id, action: "UPDATE", after: row });
    });
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/nghi-phep");
  redirect(`/nghi-phep?ok=${encodeURIComponent("Đã cập nhật định mức phép")}`);
}
