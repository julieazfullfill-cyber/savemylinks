"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { parseBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { addSupplierPrice } from "@/lib/shops";

const ROLES = ["ADMIN", "QUAN_LY", "KE_TOAN"] as const;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const back = (q: string) => redirect(`/ncc?${q}`);

export async function saveTerms(supplierId: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    const prepaid = form.get("prepaid") === "on";
    const creditDays = prepaid ? 0 : Number(str(form, "creditDays") || "0");
    if (!Number.isInteger(creditDays) || creditDays < 0 || creditDays > 365) throw new Error("Số ngày công nợ 0–365");
    await prisma.$transaction(async (tx) => {
      const before = await tx.supplier.findUniqueOrThrow({ where: { id: supplierId } });
      const after = await tx.supplier.update({ where: { id: supplierId }, data: { prepaid, creditDays } });
      await audit(tx, { actorId: me.uid, tableName: "Supplier", recordId: supplierId, action: "UPDATE", before, after });
    });
  } catch (e) {
    return back(`error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/ncc");
  back(`ok=${encodeURIComponent("Đã lưu điều khoản — dự báo dòng tiền dùng ngay")}`);
}

export async function addPrice(form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    const price = Number(str(form, "priceUsd").replace(",", "."));
    await prisma.$transaction((tx) =>
      addSupplierPrice(tx, {
        supplierId: str(form, "supplierId"),
        sku: str(form, "sku"),
        priceUsd: Math.round(price * 100) / 100,
        effectiveFrom: parseBizDate(str(form, "effectiveFrom")),
        actorId: me.uid,
      }),
    );
  } catch (e) {
    const m = (e as Error).message;
    return back(`error=${encodeURIComponent(m.includes("no_overlap") ? "Trùng thời kỳ với giá đã có" : m)}`);
  }
  revalidatePath("/ncc");
  back(`ok=${encodeURIComponent("Đã thêm giá — giá cũ cùng SKU tự đóng vào hôm trước")}`);
}
