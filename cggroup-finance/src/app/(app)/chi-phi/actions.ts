"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { parseBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { approveExpense, createExpense, payExpense, rejectExpense } from "@/lib/expenses";
import { toMinor, type Currency } from "@/lib/money";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const back = (tab: string, q: string) => redirect(`/chi-phi?tab=${tab}&${q}`);
const fail = (tab: string, e: unknown) => back(tab, `error=${encodeURIComponent((e as Error).message)}`);
const rate = (f: FormData) => str(f, "fxRate").replace(/[.\s]/g, "").replace(",", ".") || null;

export async function createExpenseAction(form: FormData) {
  const me = await requireUser();
  try {
    const currency = str(form, "currency") as Currency;
    if (currency !== "VND" && currency !== "USD") throw new Error("Chọn loại tiền");
    if (!str(form, "categoryId")) throw new Error("Chọn hạng mục");
    if (!str(form, "amount")) throw new Error("Thiếu số tiền");
    if (!str(form, "description")) throw new Error("Thiếu diễn giải");
    await prisma.$transaction((tx) =>
      createExpense(tx, {
        date: parseBizDate(str(form, "date")),
        categoryId: str(form, "categoryId"),
        supplierId: str(form, "supplierId") || null,
        amount: toMinor(str(form, "amount"), currency),
        currency,
        fxRate: currency === "USD" ? rate(form) : null,
        description: str(form, "description"),
        requestedBy: me.uid,
      }),
    );
  } catch (e) {
    return fail("DRAFT", e);
  }
  revalidatePath("/chi-phi");
  back("DRAFT", `ok=${encodeURIComponent("Đã gửi đề nghị chi — chờ duyệt")}`);
}

export async function approveAction(id: string) {
  const me = await requireUser(["ADMIN", "QUAN_LY"]);
  try {
    await prisma.$transaction((tx) => approveExpense(tx, { id, actorId: me.uid, actorRole: me.role }));
  } catch (e) {
    return fail("DRAFT", e);
  }
  revalidatePath("/chi-phi");
  back("DRAFT", `ok=${encodeURIComponent("Đã duyệt — chi phí đã ghi nhận, chờ kế toán chi")}`);
}

export async function rejectAction(id: string, form: FormData) {
  const me = await requireUser(["ADMIN", "QUAN_LY"]);
  try {
    await prisma.$transaction((tx) => rejectExpense(tx, { id, actorId: me.uid, reason: str(form, "reason") }));
  } catch (e) {
    return fail("DRAFT", e);
  }
  revalidatePath("/chi-phi");
  back("DRAFT", `ok=${encodeURIComponent("Đã từ chối")}`);
}

export async function payAction(id: string, form: FormData) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  try {
    const accountId = str(form, "accountId");
    if (!accountId) throw new Error("Chọn tài khoản chi");
    const acc = await prisma.cashAccount.findUniqueOrThrow({ where: { id: accountId } });
    const amountRaw = str(form, "amount");
    await prisma.$transaction((tx) =>
      payExpense(tx, {
        id,
        accountId,
        date: parseBizDate(str(form, "date")),
        amount: amountRaw ? toMinor(amountRaw, acc.currency as Currency) : null,
        fxRate: acc.currency === "USD" ? rate(form) : null,
        actorId: me.uid,
      }),
    );
  } catch (e) {
    return fail("APPROVED", e);
  }
  revalidatePath("/chi-phi");
  revalidatePath("/so-quy");
  back("APPROVED", `ok=${encodeURIComponent("Đã chi — giao dịch đã vào Sổ quỹ")}`);
}
