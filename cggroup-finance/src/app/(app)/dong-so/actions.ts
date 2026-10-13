"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { closePeriod, reopenPeriod, resolveCheck, runChecks } from "@/lib/closing-service";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";

const back = (thang: string, q: string) => redirect(`/dong-so?thang=${thang}&${q}`);
const msg = (e: unknown) => encodeURIComponent((e as Error).message);
const ym = (thang: string) => {
  const [year, month] = thang.split("-").map(Number);
  if (!year || !month) throw new Error("Tháng không hợp lệ");
  return { year, month };
};
const TX = { timeout: 60_000 };

export async function runChecksAction(thang: string) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  let n = 0;
  try {
    const { results } = await prisma.$transaction((tx) => runChecks(tx, { ...ym(thang), actorId: me.uid }), TX);
    n = results.filter((r) => r.level === "ERROR").length;
  } catch (e) {
    return back(thang, `error=${msg(e)}`);
  }
  revalidatePath("/dong-so");
  back(thang, `ok=${encodeURIComponent(n ? `Đã chạy kiểm tra — còn ${n} lỗi mức ERROR` : "Đã chạy kiểm tra — không có lỗi chặn")}`);
}

export async function resolveCheckAction(thang: string, resultId: string, form: FormData) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  try {
    await prisma.$transaction((tx) => resolveCheck(tx, { resultId, note: String(form.get("note") ?? ""), actorId: me.uid }));
  } catch (e) {
    return back(thang, `error=${msg(e)}`);
  }
  revalidatePath("/dong-so");
  back(thang, `ok=${encodeURIComponent("Đã ghi nhận")}`);
}

export async function closeAction(thang: string) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  let profit = 0n;
  try {
    const r = await prisma.$transaction((tx) => closePeriod(tx, { ...ym(thang), actorId: me.uid }), TX);
    profit = r.pnl.netProfitVnd;
  } catch (e) {
    // Đóng sổ thất bại thì cả transaction rollback, mất luôn lần kiểm tra vừa chạy —
    // chạy lại riêng để màn hình hiện đúng lỗi đang chặn.
    await prisma.$transaction((tx) => runChecks(tx, { ...ym(thang), actorId: me.uid }), TX).catch(() => null);
    revalidatePath("/dong-so");
    return back(thang, `error=${msg(e)}`);
  }
  revalidatePath("/", "layout");
  back(thang, `ok=${encodeURIComponent(`Đã đóng sổ — lợi nhuận ${formatMoney(profit)} kết chuyển về 302, kỳ đã khoá`)}`);
}

export async function reopenAction(thang: string, form: FormData) {
  const me = await requireUser(["ADMIN"]);
  try {
    await prisma.$transaction((tx) => reopenPeriod(tx, { ...ym(thang), reason: String(form.get("reason") ?? ""), actorId: me.uid }), TX);
  } catch (e) {
    return back(thang, `error=${msg(e)}`);
  }
  revalidatePath("/", "layout");
  back(thang, `ok=${encodeURIComponent("Đã mở lại kỳ — bút toán kết chuyển đã đảo")}`);
}
