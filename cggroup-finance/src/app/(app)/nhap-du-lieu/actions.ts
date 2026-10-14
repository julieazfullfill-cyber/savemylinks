"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { commitRow, FIELDS, KIND_VI, KINDS, saveDraft, validate, type Kind } from "@/lib/import-staging";

const back = (tab: string, q: string, anchor = "") => redirect(`/nhap-du-lieu?tab=${tab}&${q}${anchor}`);
const msg = (s: string) => encodeURIComponent(s);
const formData = (kind: Kind, form: FormData) => Object.fromEntries(FIELDS[kind].map((f) => [f.name, String(form.get(f.name) ?? "")]));

/** Lưu nháp; nếu bấm "Lưu & chốt" thì chốt luôn (cùng transaction — chốt lỗi thì nháp vẫn lưu ở bước riêng). */
export async function saveRowAction(id: string, form: FormData) {
  const me = await requireUser(["ADMIN"]);
  const row = await prisma.importRow.findUniqueOrThrow({ where: { id } });
  const kind = row.kind as Kind;
  const tab = kind.toLowerCase();
  try {
    await prisma.$transaction((tx) => saveDraft(tx, { id, data: formData(kind, form), actorId: me.uid }));
  } catch (e) {
    return back(tab, `error=${msg((e as Error).message)}`, `#r-${id}`);
  }
  if (form.get("intent") === "commit") {
    try {
      const r = await prisma.$transaction((tx) => commitRow(tx, { id, actorId: me.uid }));
      revalidatePath("/nhap-du-lieu");
      return back(tab, `ok=${msg(`Đã chốt ${KIND_VI[kind].toLowerCase()} ${row.key}${r.warnings.length ? ` — lưu ý: ${r.warnings.join("; ")}` : ""}`)}`);
    } catch (e) {
      revalidatePath("/nhap-du-lieu");
      return back(tab, `error=${msg(`Đã lưu nháp nhưng chưa chốt được: ${(e as Error).message}`)}`, `#r-${id}`);
    }
  }
  revalidatePath("/nhap-du-lieu");
  back(tab, `ok=${msg(`Đã lưu nháp ${row.key}`)}`, `#r-${id}`);
}

/** Chốt mọi dòng đã đủ của một loại (hoặc tất cả loại, theo thứ tự phụ thuộc). Dòng lỗi bỏ qua, báo lại. */
export async function commitAllAction(tab: string) {
  const me = await requireUser(["ADMIN"]);
  const kinds = tab === "tat-ca" ? KINDS : KINDS.filter((k) => k.toLowerCase() === tab);
  let ok = 0;
  const fails: string[] = [];
  for (const kind of kinds) {
    const rows = await prisma.importRow.findMany({ where: { kind, status: "DRAFT" }, orderBy: { createdAt: "asc" } });
    for (const r of rows) {
      if (validate(kind, r.data as Record<string, string>).length) continue;
      try {
        await prisma.$transaction((tx) => commitRow(tx, { id: r.id, actorId: me.uid }));
        ok++;
      } catch (e) {
        fails.push(`${r.key}: ${(e as Error).message}`);
      }
    }
  }
  revalidatePath("/nhap-du-lieu");
  const text = `Đã chốt ${ok} dòng${fails.length ? ` · ${fails.length} dòng lỗi: ${fails.slice(0, 5).join(" | ")}` : ""}`;
  back(tab, fails.length ? `error=${msg(text)}` : `ok=${msg(text)}`);
}
