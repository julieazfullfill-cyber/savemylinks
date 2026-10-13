"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseLegacyCsv } from "@/lib/pnl";

export async function importLegacy(form: FormData) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  let warn = 0;
  let n = 0;
  try {
    const rows = parseLegacyCsv(String(form.get("csv") ?? ""));
    warn = rows.filter((r) => r.warning).length;
    n = rows.length;
    await prisma.$transaction(async (tx) => {
      for (const r of rows) {
        const data = { revenueUsd: r.revenueUsd, expenseUsd: r.expenseUsd, profitUsd: r.profitUsd };
        const row = await tx.legacyPnl.upsert({
          where: { team_year_month: { team: r.team, year: r.year, month: r.month } },
          create: { team: r.team, year: r.year, month: r.month, ...data },
          update: data,
        });
        await audit(tx, { actorId: me.uid, tableName: "LegacyPnl", recordId: String(row.id), action: "UPDATE", after: row });
      }
    });
  } catch (e) {
    return redirect(`/pnl?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/pnl");
  redirect(`/pnl?ok=${encodeURIComponent(`Đã nạp ${n} dòng${warn ? ` — ${warn} dòng có profit sai công thức (xem cột cảnh báo)` : ""}`)}`);
}

/** GĐ4: ngân sách theo tháng — ô trống = bỏ ngân sách riêng của tháng (dùng mặc định của hạng mục). */
export async function saveBudgets(thang: string, form: FormData) {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  const [year, month] = thang.split("-").map(Number);
  try {
    if (!year || !month) throw new Error("Tháng không hợp lệ");
    await prisma.$transaction(async (tx) => {
      for (const [k, raw] of form.entries()) {
        if (!k.startsWith("b_")) continue;
        const categoryId = k.slice(2);
        const s = String(raw).replace(/[.\s,]/g, "");
        if (!s) {
          await tx.budget.deleteMany({ where: { year, month, categoryId } });
          continue;
        }
        if (!/^\d+$/.test(s)) throw new Error(`Ngân sách "${String(raw)}" không hợp lệ`);
        const row = await tx.budget.upsert({
          where: { year_month_categoryId: { year, month, categoryId } },
          create: { year, month, categoryId, amountVnd: BigInt(s) },
          update: { amountVnd: BigInt(s) },
        });
        await audit(tx, { actorId: me.uid, tableName: "Budget", recordId: row.id, action: "UPDATE", after: row });
      }
    });
  } catch (e) {
    return redirect(`/pnl?thang=${thang}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/pnl");
  redirect(`/pnl?thang=${thang}&ok=${encodeURIComponent(`Đã lưu ngân sách tháng ${month}/${year}`)}`);
}
