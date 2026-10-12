// Quy ước 01: giờ lưu UTC, hiển thị giờ Việt Nam. Ngày nghiệp vụ (@db.Date) là
// một ngày lịch thuần, biểu diễn bằng Date ở 00:00 UTC — không suy ra từ timestamp.

export const VN_TZ = "Asia/Ho_Chi_Minh";
const DAY_MS = 86_400_000;

/** "2026-11-02" → Date 2026-11-02T00:00:00Z. Từ chối ngày không tồn tại. */
export function parseBizDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Ngày không hợp lệ (cần YYYY-MM-DD): ${s}`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) throw new Error(`Ngày không tồn tại: ${s}`);
  return d;
}

/** Date nghiệp vụ → "YYYY-MM-DD". */
export function bizDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Ngày hôm nay theo giờ Việt Nam, dạng ngày nghiệp vụ. */
export function todayVn(now: Date = new Date()): Date {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: VN_TZ }).format(now);
  return parseBizDate(s);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** Thứ Hai của tuần chứa d (tuần bắt đầu thứ Hai). */
export function startOfWeek(d: Date): Date {
  const dow = (d.getUTCDay() + 6) % 7; // 0 = thứ Hai
  return addDays(d, -dow);
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** Ngày thứ `day` của tháng chứa d, kẹp về cuối tháng (31 → 30/28…). */
export function dayOfMonth(year: number, month0: number, day: number): Date {
  const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month0, Math.min(day, last)));
}

/** Hiển thị ngày nghiệp vụ: 02/11/2026. */
export function fmtBizDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

/** Hiển thị timestamp theo giờ Việt Nam. */
export function fmtTimestamp(d: Date): string {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: VN_TZ, dateStyle: "short", timeStyle: "short" }).format(d);
}
