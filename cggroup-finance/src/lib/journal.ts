// GĐ4: mọi bút toán đi qua đây — kiểm kỳ còn mở trước khi ghi (trigger journal_period_locked ở DB là
// lưới thứ hai, nhưng báo lỗi kém rõ hơn). Kỳ đã đóng: điều chỉnh về sau ghi vào kỳ đang mở.
import type { Prisma } from "@prisma/client";
import { todayVn } from "./dates";
import type { Tx } from "./db";

const ym = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });

export async function isPeriodClosed(tx: Tx, date: Date): Promise<boolean> {
  const p = await tx.periodClosing.findUnique({ where: { year_month: ym(date) }, select: { status: true } });
  return p?.status === "CLOSED";
}

export async function assertPeriodOpen(tx: Tx, date: Date) {
  if (await isPeriodClosed(tx, date)) {
    const { year, month } = ym(date);
    throw new Error(`Kỳ ${String(month).padStart(2, "0")}/${year} đã đóng sổ — ghi vào kỳ đang mở (ngày từ tháng sau trở đi)`);
  }
}

/** Ngày ghi bút toán điều chỉnh cho nghiệp vụ gốc ngày `date`: giữ nguyên nếu kỳ còn mở, không thì hôm nay. */
export async function postingDateFor(tx: Tx, date: Date): Promise<Date> {
  return (await isPeriodClosed(tx, date)) ? todayVn() : date;
}

export async function createJournal(tx: Tx, args: Prisma.JournalEntryCreateArgs) {
  await assertPeriodOpen(tx, args.data.date as Date);
  return tx.journalEntry.create(args);
}
