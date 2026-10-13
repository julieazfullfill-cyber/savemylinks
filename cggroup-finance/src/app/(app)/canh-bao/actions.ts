"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** Nhận xử lý một cảnh báo: ghi ai, lúc nào. Cảnh báo tự đóng khi hết bắn (số liệu đã sửa). */
export async function acknowledgeAction(id: string) {
  const me = await requireUser(["ADMIN", "KE_TOAN", "QUAN_LY"]);
  await prisma.alertLog.updateMany({ where: { id, acknowledgedAt: null }, data: { acknowledgedBy: me.uid, acknowledgedAt: new Date() } });
  revalidatePath("/canh-bao");
  redirect(`/canh-bao?ok=${encodeURIComponent("Đã nhận xử lý")}`);
}
