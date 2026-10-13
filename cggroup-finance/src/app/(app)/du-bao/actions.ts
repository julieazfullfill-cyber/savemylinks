"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { parseBizDate, startOfWeek, todayVn } from "@/lib/dates";
import { prisma, toJsonSafe } from "@/lib/db";
import { buildForecast } from "@/lib/forecast";
import { loadForecastInput } from "@/lib/forecast-data";
import { toMinor } from "@/lib/money";

const ROLES = ["ADMIN", "QUAN_LY"] as const;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const back = (qs: string, q: string) => redirect(`/du-bao?${qs ? qs + "&" : ""}${q}`);

export async function addItem(qs: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    const direction = str(form, "direction");
    if (direction !== "IN" && direction !== "OUT") throw new Error("Chọn thu hay chi");
    if (!str(form, "label")) throw new Error("Thiếu nội dung");
    const amountVnd = toMinor(str(form, "amount"), "VND");
    if (amountVnd <= 0n) throw new Error("Số tiền phải lớn hơn 0");
    const confidence = Number(str(form, "confidence") || "100");
    if (!Number.isInteger(confidence) || confidence < 1 || confidence > 100) throw new Error("Độ chắc chắn 1–100%");
    const recurring = str(form, "recurring") || null;
    if (recurring && recurring !== "MONTHLY" && recurring !== "WEEKLY") throw new Error("Lặp lại không hợp lệ");
    const item = await prisma.forecastItem.create({
      data: { expectedOn: parseBizDate(str(form, "expectedOn")), direction, amountVnd, label: str(form, "label"), confidence, recurring },
    });
    await prisma.$transaction((tx) => audit(tx, { actorId: me.uid, tableName: "ForecastItem", recordId: item.id, action: "CREATE", after: item }));
  } catch (e) {
    return back(qs, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/du-bao");
  back(qs, `ok=${encodeURIComponent("Đã thêm khoản dự kiến")}`);
}

/** Khoản dự kiến không phải bản ghi tài chính — xoá được, nhưng vẫn ghi vết. */
export async function removeItem(qs: string, id: string) {
  const me = await requireUser([...ROLES]);
  await prisma.$transaction(async (tx) => {
    const before = await tx.forecastItem.delete({ where: { id } });
    await audit(tx, { actorId: me.uid, tableName: "ForecastItem", recordId: id, action: "VOID", before });
  });
  revalidatePath("/du-bao");
  back(qs, `ok=${encodeURIComponent("Đã bỏ khoản dự kiến")}`);
}

export async function saveSnapshot(qs: string, form: FormData) {
  const me = await requireUser([...ROLES]);
  try {
    const scenario = {
      name: str(form, "name") || "Cơ sở",
      revenueFactor: Number(str(form, "rf")),
      ffRate: Number(str(form, "ff")),
      floorVnd: str(form, "floor") || "0",
    };
    if (!(scenario.revenueFactor > 0) || !(scenario.ffRate >= 0 && scenario.ffRate < 1)) throw new Error("Kịch bản không hợp lệ");
    const start = startOfWeek(todayVn());
    const { input } = await prisma.$transaction((tx) => loadForecastInput(tx, { startDate: start, scenario }));
    const rows = buildForecast(input);
    await prisma.forecastSnapshot.create({
      data: { weekStart: start, scenario, rows: toJsonSafe(rows) as object, createdBy: me.uid },
    });
  } catch (e) {
    return back(qs, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath("/du-bao");
  back(qs, `ok=${encodeURIComponent("Đã lưu dự báo tuần này — sau vài tuần sẽ thấy độ lệch")}`);
}
