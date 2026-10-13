"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { applyProviderDefaults } from "@/lib/cash-accounts";
import { catalogByKey, parseCatalogForm } from "@/lib/catalog";
import { prisma, type Tx } from "@/lib/db";

// Prisma không có kiểu chung cho delegate theo tên model — giới hạn `any` ở đúng một chỗ.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delegate = (tx: Tx, model: string): any => (tx as any)[model];

export async function saveCatalogItem(key: string, id: string | null, form: FormData) {
  const me = await requireUser(["ADMIN"]);
  const cat = catalogByKey(key);
  if (!cat) throw new Error("Danh mục không tồn tại");
  const base = `/danh-muc/${key}`;
  const back = (q: string) => redirect(`${base}?${q}`);

  let data: Record<string, unknown>;
  try {
    data = parseCatalogForm(cat, form, !id);
  } catch (e) {
    return back(`${id ? `edit=${encodeURIComponent(id)}` : "edit=new"}&error=${encodeURIComponent((e as Error).message)}`);
  }

  if (cat.model === "user") {
    if (typeof data.password === "string") data.passwordHash = await bcrypt.hash(data.password, 10);
    delete data.password;
    // Không tự khoá mình hoặc tự hạ quyền — tránh mất admin cuối cùng.
    if (id === me.uid && (data.active === false || data.role !== "ADMIN")) {
      return back(`edit=${id}&error=${encodeURIComponent("Không thể tự khoá hoặc tự bỏ quyền Admin của chính mình")}`);
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (cat.model === "cashAccount") data = await applyProviderDefaults(tx, data);
      const d = delegate(tx, cat.model);
      if (id) {
        const where = { [cat.idField]: id };
        const before = await d.findUniqueOrThrow({ where });
        const after = await d.update({ where, data });
        await audit(tx, { actorId: me.uid, tableName: cat.table, recordId: id, action: "UPDATE", before: redact(before), after: redact(after) });
      } else {
        const after = await d.create({ data });
        await audit(tx, { actorId: me.uid, tableName: cat.table, recordId: String(after[cat.idField]), action: "CREATE", after: redact(after) });
      }
    });
  } catch (e) {
    const msg = String((e as Error).message).includes("Unique constraint") ? "Mã/email đã tồn tại" : (e as Error).message;
    return back(`${id ? `edit=${encodeURIComponent(id)}` : "edit=new"}&error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(base);
  back(`ok=${encodeURIComponent(id ? "Đã lưu thay đổi" : "Đã thêm mới")}`);
}

function redact(row: Record<string, unknown>) {
  const { passwordHash, ...rest } = row;
  return passwordHash === undefined ? rest : { ...rest, passwordHash: "***" };
}
