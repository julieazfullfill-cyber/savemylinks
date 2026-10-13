"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { parseBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { addFulfillment, addRefund, recomputeOrderCosts } from "@/lib/orders";

const ROLES = ["ADMIN", "KE_TOAN"] as const;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (s: string) => {
  const v = Number(s.replace(/[$,\s]/g, "") || "0");
  if (!Number.isFinite(v)) throw new Error(`Số "${s}" không hợp lệ`);
  return v;
};
const back = (id: string, q: string) => redirect(`/don-hang/${id}?${q}`);

async function recomputeFor(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  await prisma.$transaction((tx) => recomputeOrderCosts(tx, o.orderedAt.getUTCFullYear(), o.orderedAt.getUTCMonth() + 1), { timeout: 120_000 });
}

export async function addFulfillmentAction(orderId: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    await prisma.$transaction((tx) =>
      addFulfillment(tx, {
        orderId,
        supplierId: str(form, "supplierId"),
        sku: str(form, "sku") || null,
        externalId: str(form, "externalId") || null,
        submittedAt: str(form, "submittedAt") ? parseBizDate(str(form, "submittedAt")) : null,
        costUsd: num(str(form, "costUsd")),
        shipUsd: num(str(form, "shipUsd")),
        trackingNo: str(form, "trackingNo") || null,
        actorId: me.uid,
      }),
    );
    await recomputeFor(orderId);
  } catch (e) {
    return back(orderId, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/don-hang");
  back(orderId, `ok=${encodeURIComponent("Đã ghép đơn fulfill — giá vốn đã cập nhật")}`);
}

export async function setFulfillStatus(orderId: string, fulfillmentId: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  const status = str(form, "status") as "PENDING" | "SUBMITTED" | "IN_PRODUCTION" | "SHIPPED" | "DELIVERED" | "FAILED";
  try {
    await prisma.$transaction(async (tx) => {
      const before = await tx.fulfillmentOrder.findUniqueOrThrow({ where: { id: fulfillmentId } });
      const after = await tx.fulfillmentOrder.update({ where: { id: fulfillmentId }, data: { status, trackingNo: str(form, "trackingNo") || before.trackingNo } });
      await audit(tx, { actorId: me.uid, tableName: "FulfillmentOrder", recordId: fulfillmentId, action: "UPDATE", before, after });
      // cả đơn: mọi đơn fulfill đã giao → đơn bán DELIVERED; đã gửi → FULFILLED
      const all = await tx.fulfillmentOrder.findMany({ where: { orderId } });
      const live = all.filter((f) => f.status !== "FAILED");
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      if (order.status !== "CANCELLED" && order.status !== "REFUNDED" && live.length) {
        const next = live.every((f) => f.status === "DELIVERED") ? "DELIVERED" : live.every((f) => f.status === "SHIPPED" || f.status === "DELIVERED") ? "FULFILLED" : "PROCESSING";
        await tx.order.update({ where: { id: orderId }, data: { status: next } });
      }
    });
    await recomputeFor(orderId);
  } catch (e) {
    return back(orderId, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/don-hang");
  back(orderId, `ok=${encodeURIComponent("Đã cập nhật đơn fulfill")}`);
}

export async function addRefundAction(orderId: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    await prisma.$transaction((tx) =>
      addRefund(tx, { orderId, refundedAt: parseBizDate(str(form, "refundedAt")), amountUsd: num(str(form, "amountUsd")), reason: str(form, "reason") || null, actorId: me.uid }),
    );
    await recomputeFor(orderId);
  } catch (e) {
    return back(orderId, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/don-hang");
  back(orderId, `ok=${encodeURIComponent("Đã ghi hoàn tiền")}`);
}

export async function cancelOrder(orderId: string) {
  const me = await requireUser([...ROLES]);
  try {
    await prisma.$transaction(async (tx) => {
      const before = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const after = await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
      await audit(tx, { actorId: me.uid, tableName: "Order", recordId: orderId, action: "UPDATE", before, after });
    });
    await recomputeFor(orderId);
  } catch (e) {
    return back(orderId, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/don-hang");
  back(orderId, `ok=${encodeURIComponent("Đã huỷ đơn — không còn gánh chi phí chung")}`);
}

export async function recomputeMonth(thang: string) {
  await requireUser([...ROLES]);
  const [y, m] = thang.split("-").map(Number);
  await prisma.$transaction((tx) => recomputeOrderCosts(tx, y, m), { timeout: 180_000 });
  revalidatePath("/don-hang");
  revalidatePath("/bien-lai");
  redirect(`/don-hang?thang=${thang}&ok=${encodeURIComponent("Đã tính lại giá vốn và phân bổ chi phí chung")}`);
}
