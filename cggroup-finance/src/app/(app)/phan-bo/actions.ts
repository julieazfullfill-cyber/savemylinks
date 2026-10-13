"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Basis } from "@/lib/allocation";
import { runAllocation, saveRule, undoAllocation } from "@/lib/allocation-service";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";

const ROLES = ["ADMIN", "KE_TOAN"] as const;
const back = (thang: string, q: string) => redirect(`/phan-bo?thang=${thang}&${q}`);
const msg = (e: unknown) => encodeURIComponent((e as Error).message);

export async function saveRuleAction(thang: string, id: string | null, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    await prisma.$transaction((tx) =>
      saveRule(tx, {
        id: id ?? undefined,
        name: String(form.get("name") ?? ""),
        sourceAccounts: form.getAll("acc").map(String),
        basis: String(form.get("basis") ?? "REVENUE") as Basis,
        active: form.get("active") === "on",
        actorId: me.uid,
      }),
    );
  } catch (e) {
    return back(thang, `error=${msg(e)}`);
  }
  revalidatePath("/phan-bo");
  back(thang, `ok=${encodeURIComponent("Đã lưu quy tắc")}`);
}

export async function runAction(thang: string, ruleId: string) {
  const me = await requireUser([...ROLES]);
  const [year, month] = thang.split("-").map(Number);
  let pool = 0n;
  try {
    const r = await prisma.$transaction((tx) => runAllocation(tx, { ruleId, year, month, actorId: me.uid }), { timeout: 30_000 });
    pool = r.run.poolVnd;
  } catch (e) {
    return back(thang, `error=${msg(e)}`);
  }
  revalidatePath("/phan-bo");
  revalidatePath("/pnl");
  back(thang, `ok=${encodeURIComponent(`Đã phân bổ ${formatMoney(pool)} về các shop — bút toán đã vào sổ cái`)}`);
}

export async function undoAction(thang: string, runId: string) {
  const me = await requireUser([...ROLES]);
  try {
    await prisma.$transaction((tx) => undoAllocation(tx, { runId, actorId: me.uid }));
  } catch (e) {
    return back(thang, `error=${msg(e)}`);
  }
  revalidatePath("/phan-bo");
  back(thang, `ok=${encodeURIComponent("Đã huỷ lần chạy — bút toán đảo đã ghi")}`);
}
