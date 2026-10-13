"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { checkHeaders, importSheet, parseCsv, SHEETS, type RowResult, type SheetName } from "@/lib/import-1a";

export type ImportState = { sheet?: string; dryRun?: boolean; results?: RowResult[]; error?: string } | null;

class DryRunRollback extends Error {}

export async function runImport(_prev: ImportState, form: FormData): Promise<ImportState> {
  const me = await requireUser(["ADMIN", "KE_TOAN"]);
  const sheet = String(form.get("sheet") ?? "") as SheetName;
  const dryRun = form.get("mode") !== "commit";
  try {
    if (!(sheet in SHEETS)) throw new Error("Chọn sheet");
    const { headers, rows } = parseCsv(String(form.get("data") ?? ""));
    checkHeaders(sheet, headers);
    if (rows.length > 2000) throw new Error("Tối đa 2.000 dòng mỗi lần");
    let results: RowResult[] = [];
    try {
      await prisma.$transaction(
        async (tx) => {
          results = await importSheet(tx, sheet, rows, me.uid);
          // Xem trước: chạy thật trong transaction rồi huỷ — kết quả giống hệt lúc nạp.
          if (dryRun) throw new DryRunRollback();
        },
        { timeout: 120_000 },
      );
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
    if (!dryRun) {
      revalidatePath("/so-quy");
      revalidatePath("/cong-no");
      revalidatePath("/chi-phi");
    }
    return { sheet, dryRun, results };
  } catch (e) {
    return { sheet, dryRun, error: (e as Error).message };
  }
}
