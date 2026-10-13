"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { parseBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { toMinor } from "@/lib/money";
import {
  approvePeriod,
  calculatePeriod,
  closePeriod,
  createPeriod,
  overrideHeldBonus,
  payLiability,
  payPeriod,
  setAdjustment,
  updatePeriod,
} from "@/lib/payroll-service";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const done = (id: string, ok: string) => {
  revalidatePath("/ky-luong");
  redirect(`/ky-luong/${id}?ok=${encodeURIComponent(ok)}`);
};
const fail = (id: string, e: unknown) => redirect(`/ky-luong/${id}?error=${encodeURIComponent((e as Error).message)}`);
const profit = (f: FormData) => (str(f, "profit") ? toMinor(str(f, "profit"), "VND") : null);

export async function createPeriodAction(form: FormData) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  let id = "";
  try {
    const [y, m] = str(form, "thang").split("-").map(Number);
    if (!y || !m) throw new Error("Chọn tháng");
    const p = await prisma.$transaction((tx) =>
      createPeriod(tx, { year: y, month: m, standardDays: Number(str(form, "standardDays").replace(",", ".")), companyProfitVnd: profit(form), actorId: me.uid }),
    );
    id = p.id;
  } catch (e) {
    const msg = String((e as Error).message).includes("Unique constraint") ? "Kỳ lương tháng này đã có" : (e as Error).message;
    return redirect(`/ky-luong?error=${encodeURIComponent(msg)}`);
  }
  done(id, "Đã tạo kỳ — nhập điều chỉnh (nếu có) rồi bấm Tính lương");
}

export async function updatePeriodAction(id: string, form: FormData) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  try {
    await prisma.$transaction((tx) =>
      updatePeriod(tx, { periodId: id, standardDays: Number(str(form, "standardDays").replace(",", ".")), companyProfitVnd: profit(form), actorId: me.uid }),
    );
  } catch (e) {
    return fail(id, e);
  }
  done(id, "Đã lưu — bấm Tính lương để tính lại");
}

export async function saveAdjustments(id: string, employeeIds: string[], form: FormData) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  try {
    await prisma.$transaction(async (tx) => {
      for (const emp of employeeIds) {
        const perf = str(form, `perf_${emp}`);
        const pen = str(form, `pen_${emp}`);
        const note = str(form, `note_${emp}`);
        const existing = await tx.payrollAdjustment.findUnique({ where: { periodId_employeeId: { periodId: id, employeeId: emp } } });
        if (!perf && !pen && !note && !existing) continue;
        await setAdjustment(tx, {
          periodId: id,
          employeeId: emp,
          perfPayVnd: perf ? toMinor(perf, "VND") : 0n,
          penaltyVnd: pen ? toMinor(pen, "VND") : 0n,
          note: note || null,
          actorId: me.uid,
        });
      }
    });
  } catch (e) {
    return fail(id, e);
  }
  done(id, "Đã lưu điều chỉnh — bấm Tính lương để tính lại");
}

export async function calculateAction(id: string) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  try {
    await prisma.$transaction((tx) => calculatePeriod(tx, id, me.uid), { timeout: 60_000 });
  } catch (e) {
    return fail(id, e);
  }
  done(id, "Đã tính lương — kiểm tra rồi trình duyệt");
}

export async function approveAction(id: string) {
  const me = await requireUser(["ADMIN", "QUAN_LY"]);
  try {
    await prisma.$transaction((tx) => approvePeriod(tx, id, me.uid));
  } catch (e) {
    return fail(id, e);
  }
  done(id, "Đã duyệt — bút toán lương đã vào sổ cái");
}

export async function overrideAction(id: string, revoke: boolean) {
  const me = await requireUser(["ADMIN"]);
  try {
    await prisma.$transaction((tx) => overrideHeldBonus(tx, { periodId: id, actorId: me.uid, revoke }));
  } catch (e) {
    return fail(id, e);
  }
  done(id, revoke ? "Đã thu hồi phê duyệt vượt cấp — tính lại lương" : "Đã phê duyệt chi thưởng bị giữ — tính lại lương");
}

export async function payAction(id: string, form: FormData) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  try {
    await prisma.$transaction((tx) => payPeriod(tx, { periodId: id, accountId: str(form, "accountId"), date: parseBizDate(str(form, "date")), actorId: me.uid }));
  } catch (e) {
    return fail(id, e);
  }
  revalidatePath("/so-quy");
  done(id, "Đã chi lương — giao dịch đã vào Sổ quỹ");
}

export async function payLiabilityAction(id: string, kind: "INSURANCE" | "PIT", form: FormData) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  try {
    await prisma.$transaction((tx) =>
      payLiability(tx, { periodId: id, kind, accountId: str(form, "accountId"), date: parseBizDate(str(form, "date")), amountVnd: toMinor(str(form, "amount"), "VND"), actorId: me.uid }),
    );
  } catch (e) {
    return fail(id, e);
  }
  revalidatePath("/so-quy");
  done(id, kind === "INSURANCE" ? "Đã ghi nộp BHXH" : "Đã ghi nộp thuế TNCN");
}

export async function closeAction(id: string) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  try {
    await prisma.$transaction((tx) => closePeriod(tx, { periodId: id, actorId: me.uid }));
  } catch (e) {
    return fail(id, e);
  }
  done(id, "Đã khoá kỳ");
}
