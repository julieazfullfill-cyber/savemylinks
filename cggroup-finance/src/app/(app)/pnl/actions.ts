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
