"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { parseBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { toMinor } from "@/lib/money";
import { addFiling, changeShopStatus, completeFiling, saveShop } from "@/lib/shops";

const EDIT = ["ADMIN", "QUAN_LY"] as const;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (q: string, e: unknown) => {
  const m = (e as Error).message;
  redirect(`/shop?${q}error=${encodeURIComponent(m.includes("Unique constraint") ? "Mã shop đã tồn tại" : m)}`);
};
const ok = (msg: string) => {
  revalidatePath("/shop");
  revalidatePath("/so-quy");
  redirect(`/shop?ok=${encodeURIComponent(msg)}`);
};

export async function saveShopAction(id: string | null, form: FormData) {
  const me = await requireUser([...EDIT]);
  try {
    await prisma.$transaction((tx) =>
      saveShop(tx, id, {
        code: str(form, "code"),
        name: str(form, "name"),
        channel: str(form, "channel"),
        entityId: str(form, "entityId") || null,
        payoutAccountId: str(form, "payoutAccountId") || null,
        ownerId: str(form, "ownerId") || null,
        openedAt: str(form, "openedAt") ? parseBizDate(str(form, "openedAt")) : null,
        actorId: me.uid,
      }),
    );
  } catch (e) {
    return fail(`edit=${id ?? "new"}&`, e);
  }
  ok(id ? "Đã lưu shop" : "Đã thêm shop");
}

export async function changeStatusAction(shopId: string, form: FormData) {
  const me = await requireUser([...EDIT]);
  try {
    await prisma.$transaction((tx) =>
      changeShopStatus(tx, {
        shopId,
        toStatus: str(form, "toStatus"),
        at: str(form, "at") ? parseBizDate(str(form, "at")) : todayVn(),
        note: str(form, "note") || null,
        actorId: me.uid,
      }),
    );
  } catch (e) {
    return fail("", e);
  }
  revalidatePath("/suc-khoe-shop");
  ok("Đã đổi trạng thái — đã ghi vào lịch sử sức khoẻ shop");
}

export async function addFilingAction(form: FormData) {
  const me = await requireUser([...EDIT, "KE_TOAN"]);
  try {
    await prisma.$transaction((tx) =>
      addFiling(tx, {
        entityId: str(form, "entityId"),
        kind: str(form, "kind"),
        dueDate: parseBizDate(str(form, "dueDate")),
        amountVnd: str(form, "amount") ? toMinor(str(form, "amount"), "VND") : null,
        actorId: me.uid,
      }),
    );
  } catch (e) {
    return fail("", e);
  }
  revalidatePath("/du-bao");
  ok("Đã thêm nghĩa vụ — khoản có số tiền sẽ vào dự báo dòng tiền");
}

export async function completeFilingAction(id: string) {
  const me = await requireUser([...EDIT, "KE_TOAN"]);
  try {
    await prisma.$transaction((tx) => completeFiling(tx, { id, on: todayVn(), actorId: me.uid }));
  } catch (e) {
    return fail("", e);
  }
  revalidatePath("/du-bao");
  ok("Đã đánh dấu hoàn thành");
}
