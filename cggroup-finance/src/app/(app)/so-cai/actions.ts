"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { parseBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";
import type { LineDraft } from "@/lib/ledger";
import { MANUAL_ROWS, postManualJournal, reverseManualJournal } from "@/lib/manual-journal";
import { toMinor } from "@/lib/money";

const ROLES = ["ADMIN", "KE_TOAN"] as const;
const back = (qs: string, q: string) => redirect(`/so-cai?${qs ? qs + "&" : ""}${q}`);
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function postManualAction(qs: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    if (!str(form, "date")) throw new Error("Thiếu ngày bút toán");
    const lines: LineDraft[] = [];
    for (let i = 0; i < MANUAL_ROWS; i++) {
      const acc = str(form, `acc${i}`);
      const dr = str(form, `dr${i}`);
      const cr = str(form, `cr${i}`);
      if (!acc && !dr && !cr) continue;
      if (!acc) throw new Error(`Dòng ${i + 1}: chọn tài khoản`);
      if (dr && cr) throw new Error(`Dòng ${i + 1}: chỉ ghi một phía nợ hoặc có`);
      lines.push({ accountCode: acc, debitVnd: dr ? toMinor(dr, "VND") : 0n, creditVnd: cr ? toMinor(cr, "VND") : 0n, shopId: str(form, `shop${i}`) || null });
    }
    await prisma.$transaction((tx) => postManualJournal(tx, { date: parseBizDate(str(form, "date")), memo: str(form, "memo"), lines, actorId: me.uid }));
  } catch (e) {
    return back(qs, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/so-cai");
  back(qs, `ok=${encodeURIComponent("Đã ghi bút toán điều chỉnh")}`);
}

export async function reverseManualAction(qs: string, id: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    await prisma.$transaction((tx) => reverseManualJournal(tx, { id, reason: str(form, "reason"), actorId: me.uid }));
  } catch (e) {
    return back(qs, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/so-cai");
  back(qs, `ok=${encodeURIComponent("Đã đảo bút toán")}`);
}
