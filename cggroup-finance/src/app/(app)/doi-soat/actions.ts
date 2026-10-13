"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { parseBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { parseCsv } from "@/lib/order-import";
import { createPayout, parsePayoutLines, postPayout } from "@/lib/payouts";

const ROLES = ["ADMIN", "KE_TOAN"] as const;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (s: string, label: string) => {
  const v = Number(s.replace(/[$,\s]/g, ""));
  if (!s || !Number.isFinite(v)) throw new Error(`${label} không hợp lệ`);
  return Math.round(v * 100) / 100;
};
const back = (q: string) => redirect(`/doi-soat?${q}`);

export async function createPayoutAction(form: FormData) {
  const me = await requireUser([...ROLES]);
  let msg = "";
  try {
    const gross = num(str(form, "grossUsd"), "Gross");
    const fee = str(form, "feeUsd") ? num(str(form, "feeUsd"), "Phí") : 0;
    const net = str(form, "netUsd") ? num(str(form, "netUsd"), "Net") : Math.round((gross - fee) * 100) / 100;
    const lines = str(form, "lines") ? parsePayoutLines(parseCsv(str(form, "lines"))) : [];
    const { result } = await prisma.$transaction((tx) =>
      createPayout(tx, {
        shopId: str(form, "shopId"),
        accountId: str(form, "accountId") || null,
        periodFrom: parseBizDate(str(form, "periodFrom")),
        periodTo: parseBizDate(str(form, "periodTo")),
        grossUsd: gross,
        feeUsd: fee,
        netUsd: net,
        arrivedAt: str(form, "arrivedAt") ? parseBizDate(str(form, "arrivedAt")) : null,
        lines,
        actorId: me.uid,
      }),
    );
    msg = !lines.length
      ? "Đã tạo payout (chưa có dòng chi tiết — chưa đối soát)"
      : result.withinTolerance
        ? `Đã tạo và đối soát: khớp $${result.matchedUsd}, lệch $${result.diffUsd}`
        : `Đã tạo nhưng LỆCH $${result.diffUsd} so với net — kiểm tra dòng thiếu`;
  } catch (e) {
    return back(`error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/doi-soat");
  back(`ok=${encodeURIComponent(msg)}`);
}

export async function postPayoutAction(payoutId: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    await prisma.$transaction((tx) =>
      postPayout(tx, {
        payoutId,
        date: str(form, "date") ? parseBizDate(str(form, "date")) : null,
        fxRate: str(form, "fxRate").replace(/[.\s]/g, "").replace(",", ".") || null,
        actorId: me.uid,
      }),
    );
  } catch (e) {
    return back(`error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/doi-soat");
  revalidatePath("/so-quy");
  back(`ok=${encodeURIComponent("Đã ghi tiền về vào Sổ quỹ (Thu từ shop)")}`);
}
