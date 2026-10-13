"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { saveKpiMonth } from "@/lib/kpi-service";
import { overrideHeldBonus } from "@/lib/payroll-service";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
/** USD: chữ số, tối đa 2 số lẻ sau "." hoặc "," — không dùng dấu phân cách nghìn (4000 hoặc 4000,5). */
const usd = (s: string) => {
  const t = s.replace(/\s/g, "");
  if (!/^\d+([.,]\d{1,2})?$/.test(t)) throw new Error(`Số USD "${s}" không hợp lệ — nhập dạng 4000 hoặc 4000,50, không có dấu nghìn`);
  return Number(t.replace(",", "."));
};
const back = (thang: string, q: string) => redirect(`/kpi?thang=${thang}&${q}`);

export async function saveKpi(year: number, month: number, employeeIds: string[], form: FormData) {
  const me = await requireUser(["ADMIN", "QUAN_LY"]);
  const thang = `${year}-${String(month).padStart(2, "0")}`;
  try {
    const rows = employeeIds.map((id) => ({
      employeeId: id,
      targetUsd: usd(str(form, `target_${id}`) || "0"),
      shopIds: form.getAll(`shops_${id}`).map(String).filter(Boolean),
      cashReceivedUsd: usd(str(form, `cash_${id}`) || "0"),
      ffCostUsd: usd(str(form, `ff_${id}`) || "0"),
    }));
    await prisma.$transaction(
      (tx) => saveKpiMonth(tx, { year, month, overheadTotalUsd: usd(str(form, "overhead") || "0"), rows, actorId: me.uid }),
      { timeout: 30_000 },
    );
  } catch (e) {
    return back(thang, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/kpi");
  back(thang, `ok=${encodeURIComponent("Đã tính KPI & thưởng — kỳ lương tháng này cần tính lại")}`);
}

export async function overrideFromKpi(thang: string, periodId: string, revoke: boolean) {
  const me = await requireUser(["ADMIN"]);
  try {
    await prisma.$transaction((tx) => overrideHeldBonus(tx, { periodId, actorId: me.uid, revoke }));
  } catch (e) {
    return back(thang, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/kpi");
  back(thang, `ok=${encodeURIComponent(revoke ? "Đã thu hồi phê duyệt" : "Đã phê duyệt chi thưởng — vào Kỳ lương để tính lại")}`);
}

export async function saveTier(thang: string, id: string, form: FormData) {
  const me = await requireUser(["ADMIN"]);
  try {
    const fromPct = Number(str(form, "fromPct"));
    const toPct = str(form, "toPct") ? Number(str(form, "toPct")) : null;
    const ratePct = Number(str(form, "ratePct").replace(",", "."));
    const capVnd = str(form, "capVnd") ? BigInt(str(form, "capVnd").replace(/[.\s]/g, "")) : null;
    if (!(fromPct >= 0) || (toPct !== null && toPct <= fromPct) || !(ratePct >= 0 && ratePct <= 100)) throw new Error("Bậc thưởng không hợp lệ");
    await prisma.$transaction(async (tx) => {
      const before = await tx.bonusRule.findUniqueOrThrow({ where: { id } });
      const after = await tx.bonusRule.update({ where: { id }, data: { fromPct, toPct, ratePct, capVnd } });
      await audit(tx, { actorId: me.uid, tableName: "BonusRule", recordId: id, action: "UPDATE", before, after });
    });
  } catch (e) {
    return back(thang, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/kpi");
  back(thang, `ok=${encodeURIComponent("Đã lưu bậc thưởng — bấm Tính KPI lại để áp dụng")}`);
}
