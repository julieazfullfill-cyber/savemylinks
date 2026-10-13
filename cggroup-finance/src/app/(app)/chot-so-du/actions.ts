"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { parseClosingForm } from "@/lib/closing";
import { bizDateStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import type { Currency } from "@/lib/money";

export async function saveClosing(form: FormData) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  let date = "";
  try {
    const accounts = await prisma.cashAccount.findMany({ where: { active: true } });
    const parsed = parseClosingForm(
      form,
      accounts.map((a) => ({ id: a.id, code: a.code, currency: a.currency as Currency })),
    );
    date = bizDateStr(parsed.date);
    await prisma.$transaction(async (tx) => {
      for (const r of parsed.rows) {
        const where = { accountId_date: { accountId: r.accountId, date: parsed.date } };
        const before = await tx.accountBalance.findUnique({ where });
        const data = { available: r.available, reserved: r.reserved, releaseOn: r.releaseOn, note: r.note };
        const after = await tx.accountBalance.upsert({ where, create: { accountId: r.accountId, date: parsed.date, ...data }, update: data });
        await audit(tx, { actorId: me.uid, tableName: "AccountBalance", recordId: after.id, action: before ? "UPDATE" : "CREATE", before: before ?? undefined, after });
      }
    });
  } catch (e) {
    return redirect(`/chot-so-du?${date ? `date=${date}&` : ""}error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/chot-so-du");
  revalidatePath("/tong-quan");
  redirect(`/chot-so-du?date=${date}&ok=${encodeURIComponent("Đã chốt số dư")}`);
}
