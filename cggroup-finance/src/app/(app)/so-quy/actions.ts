"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { parseCashTxnForm, parseFxRateForm, readCashTxnHead } from "@/lib/cashbook-forms";
import { prisma } from "@/lib/db";
import { postCashTxn, voidCashTxn } from "@/lib/ledger";
import type { Currency } from "@/lib/money";

const ROLES = ["ADMIN", "KE_TOAN"] as const;
const back = (qs: string, q: string) => redirect(`/so-quy?${qs ? qs + "&" : ""}${q}`);

export async function createCashTxn(qs: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    const { accountId } = readCashTxnHead(form);
    const account = await prisma.cashAccount.findUniqueOrThrow({ where: { id: accountId } });
    const data = parseCashTxnForm(form, account.currency as Currency);
    await prisma.$transaction((tx) => postCashTxn(tx, { ...data, actorId: me.uid }));
  } catch (e) {
    return back(qs, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/so-quy");
  back(qs, `ok=${encodeURIComponent("Đã ghi giao dịch và bút toán")}`);
}

export async function voidCashTxnAction(qs: string, id: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  const reason = String(form.get("reason") ?? "").trim();
  try {
    if (!reason) throw new Error("Cần ghi lý do huỷ");
    await prisma.$transaction((tx) => voidCashTxn(tx, { id, actorId: me.uid, reason }));
  } catch (e) {
    return back(qs, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/so-quy");
  back(qs, `ok=${encodeURIComponent("Đã huỷ giao dịch — bút toán ngược đã ghi")}`);
}

export async function saveFxRate(qs: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    const { date, rate } = parseFxRateForm(form);
    await prisma.$transaction(async (tx) => {
      const where = { date_base_quote: { date, base: "USD" as const, quote: "VND" as const } };
      const before = await tx.fxRate.findUnique({ where });
      const after = await tx.fxRate.upsert({ where, create: { date, base: "USD", quote: "VND", rate }, update: { rate } });
      await audit(tx, { actorId: me.uid, tableName: "FxRate", recordId: String(after.id), action: before ? "UPDATE" : "CREATE", before: before ?? undefined, after });
    });
  } catch (e) {
    return back(qs, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/so-quy");
  back(qs, `ok=${encodeURIComponent("Đã lưu tỷ giá")}`);
}
