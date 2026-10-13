"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Currency } from "@/lib/money";
import { createBill, payBill } from "@/lib/payables";
import { parseBillForm, parsePayForm } from "@/lib/payables-forms";

const ROLES = ["ADMIN", "KE_TOAN"] as const;
const back = (qs: string, q: string) => redirect(`/cong-no?${qs ? qs + "&" : ""}${q}`);

export async function createBillAction(qs: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    const data = parseBillForm(form);
    await prisma.$transaction((tx) => createBill(tx, { ...data, actorId: me.uid }));
  } catch (e) {
    return back(qs, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/cong-no");
  back(qs, `ok=${encodeURIComponent("Đã ghi nhận hoá đơn — Nợ chi phí / Có 201")}`);
}

export async function payBillAction(qs: string, billId: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    const accountId = String(form.get("accountId") ?? "");
    if (!accountId) throw new Error("Chọn tài khoản trả");
    const acc = await prisma.cashAccount.findUniqueOrThrow({ where: { id: accountId } });
    const data = parsePayForm(form, acc.currency as Currency);
    await prisma.$transaction((tx) => payBill(tx, { ...data, billId, actorId: me.uid }));
  } catch (e) {
    return back(qs, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/cong-no");
  revalidatePath("/so-quy");
  back(qs, `ok=${encodeURIComponent("Đã ghi thanh toán — giao dịch đã vào Sổ quỹ")}`);
}
