"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { parseBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { toMinor, type Currency } from "@/lib/money";
import { commitSource, rematchShops, saveRows, type RowEdit } from "@/lib/report-staging";

const ROLES = ["ADMIN", "KE_TOAN"] as const;
const back = (src: string, q: string) => redirect(`/doi-chieu-thu-chi?nguon=${src}&${q}`);
const msg = (s: string) => encodeURIComponent(s);
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/** Đọc form bảng: mỗi dòng có các ô `<id>.<field>`. */
async function readEdits(source: string, form: FormData): Promise<RowEdit[]> {
  const rows = await prisma.stagedTxn.findMany({ where: { source, status: { not: "LOCKED" } } });
  const rate = str(form, "rate").replace(/[.\s]/g, "").replace(",", ".");
  if (rate && !(Number(rate) >= 1000 && Number(rate) <= 100000)) throw new Error("Tỷ giá tháng không hợp lệ");
  const bulk = str(form, "bulkAccount");
  const bulkSection = str(form, "bulkSection");
  return rows.map((r) => {
    const g = (k: string) => str(form, `${r.id}.${k}`);
    let accountId = g("account") || null;
    if (!accountId && bulk && (!bulkSection || bulkSection === r.section)) accountId = bulk;
    const amt = g("amount");
    return {
      id: r.id,
      date: g("date") ? parseBizDate(g("date")) : undefined,
      amount: amt ? toMinor(amt.replace(/\s/g, ""), r.currency as Currency) : undefined,
      fxRate: rate || undefined,
      accountId,
      shopId: g("shop") || null,
      incomeGl: g("gl") || null,
      categoryId: g("cat") || null,
      supplierId: g("sup") || null,
      skip: form.get(`${r.id}.skip`) === "on",
    };
  });
}

export async function rematchAction(source: string) {
  const me = await requireUser([...ROLES]);
  const n = await prisma.$transaction((tx) => rematchShops(tx, me.uid), { timeout: 60_000 });
  revalidatePath("/doi-chieu-thu-chi");
  back(source, `ok=${msg(n ? `Đã ghép thêm shop cho ${n} dòng` : "Không ghép thêm được dòng nào — tạo shop ở màn 16 với tên giống trong file")}`);
}

export async function saveAction(source: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  const commit = form.get("intent") === "commit";
  try {
    const edits = await readEdits(source, form);
    await prisma.$transaction((tx) => saveRows(tx, edits, me.uid), { timeout: 60_000 });
  } catch (e) {
    return back(source, `error=${msg((e as Error).message)}`);
  }
  if (commit) {
    try {
      const n = await prisma.$transaction((tx) => commitSource(tx, { source, actorId: me.uid }), { timeout: 120_000 });
      revalidatePath("/", "layout");
      return back(source, `ok=${msg(`Đã chốt ${n} dòng — đã thành giao dịch Sổ quỹ và khoá`)}`);
    } catch (e) {
      revalidatePath("/doi-chieu-thu-chi");
      return back(source, `error=${msg(`Đã lưu nhưng chưa chốt: ${(e as Error).message}`)}`);
    }
  }
  revalidatePath("/doi-chieu-thu-chi");
  back(source, `ok=${msg("Đã lưu")}`);
}
