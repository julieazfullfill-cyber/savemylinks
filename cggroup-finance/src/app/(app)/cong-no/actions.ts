"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseBizDate } from "@/lib/dates";
import { toMinor, type Currency } from "@/lib/money";
import { createAr, createTax, payTax, receiveAr } from "@/lib/receivables";
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

// ───────────── GĐ4: phải thu, nghĩa vụ thuế

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const vndOf = (f: FormData, k: string) => {
  const s = str(f, k).replace(/[.\s,]/g, "");
  if (!/^\d+$/.test(s) || s === "0") throw new Error("Số tiền VND không hợp lệ");
  return BigInt(s);
};
const date = (f: FormData, k: string, label: string) => {
  if (!str(f, k)) throw new Error(`Thiếu ${label}`);
  return parseBizDate(str(f, k));
};
/** Số tiền theo tiền của tài khoản (USD có số lẻ). */
async function cashAmount(f: FormData) {
  const accountId = str(f, "accountId");
  if (!accountId) throw new Error("Chọn tài khoản");
  const acc = await prisma.cashAccount.findUniqueOrThrow({ where: { id: accountId } });
  const amount = toMinor(str(f, "amount").replace(/\s/g, ""), acc.currency as Currency);
  if (amount <= 0n) throw new Error("Số tiền phải lớn hơn 0");
  return { accountId, amount, date: date(f, "date", "ngày") };
}
const done = (tab: string, ok: string) => {
  revalidatePath("/cong-no");
  revalidatePath("/so-quy");
  redirect(`/cong-no?tab=${tab}&ok=${encodeURIComponent(ok)}`);
};
const fail = (tab: string, e: unknown) => redirect(`/cong-no?tab=${tab}&error=${encodeURIComponent((e as Error).message)}`);

export async function createArAction(form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    await prisma.$transaction((tx) =>
      createAr(tx, {
        counterparty: str(form, "counterparty"),
        issueDate: date(form, "issueDate", "ngày ghi nhận"),
        dueDate: date(form, "dueDate", "hạn thu"),
        amountVnd: vndOf(form, "amountVnd"),
        accountCode: str(form, "accountCode"),
        note: str(form, "note"),
        actorId: me.uid,
      }),
    );
  } catch (e) {
    return fail("phai-thu", e);
  }
  done("phai-thu", "Đã ghi nhận phải thu — Nợ 131");
}

export async function receiveArAction(invoiceId: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    const c = await cashAmount(form);
    await prisma.$transaction((tx) => receiveAr(tx, { invoiceId, ...c, actorId: me.uid }));
  } catch (e) {
    return fail("phai-thu", e);
  }
  done("phai-thu", "Đã thu — giao dịch đã vào Sổ quỹ");
}

export async function createTaxAction(form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    await prisma.$transaction((tx) =>
      createTax(tx, {
        kind: str(form, "kind"),
        periodLabel: str(form, "periodLabel"),
        dueDate: date(form, "dueDate", "hạn nộp"),
        amountVnd: vndOf(form, "amountVnd"),
        entityId: str(form, "entityId") || null,
        actorId: me.uid,
      }),
    );
  } catch (e) {
    return fail("thue", e);
  }
  done("thue", "Đã thêm nghĩa vụ — đã vào dự báo dòng tiền");
}

export async function payTaxAction(id: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    const c = await cashAmount(form);
    await prisma.$transaction((tx) => payTax(tx, { id, ...c, actorId: me.uid }));
  } catch (e) {
    return fail("thue", e);
  }
  done("thue", "Đã nộp — giao dịch đã vào Sổ quỹ");
}
