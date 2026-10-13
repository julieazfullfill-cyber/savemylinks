// Màn hình 5 — Chốt số dư cuối ngày. Hàm thuần: đọc form nhiều tài khoản một lần.
import { parseBizDate } from "./dates";
import { toMinor, type Currency } from "./money";

export type ClosingRow = {
  accountId: string;
  available: bigint;
  reserved: bigint;
  releaseOn: Date | null;
  note: string | null;
};

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/**
 * Mỗi tài khoản có các ô avail_<id>, res_<id>, rel_<id>, note_<id>. Tài khoản bỏ trống
 * ô khả dụng thì không chốt. Số nhập theo tiền của tài khoản (đồng / đô).
 */
export function parseClosingForm(f: FormData, accounts: { id: string; code: string; currency: Currency }[]) {
  if (!str(f, "date")) throw new Error("Thiếu ngày chốt");
  const date = parseBizDate(str(f, "date"));
  const rows: ClosingRow[] = [];
  for (const a of accounts) {
    const avail = str(f, `avail_${a.id}`);
    if (!avail) continue;
    const reservedRaw = str(f, `res_${a.id}`);
    const reserved = reservedRaw ? toMinor(reservedRaw, a.currency) : 0n;
    if (reserved < 0n) throw new Error(`${a.code}: số bị giam không được âm`);
    const rel = str(f, `rel_${a.id}`);
    const releaseOn = rel ? parseBizDate(rel) : null;
    if (reserved > 0n && !releaseOn) throw new Error(`${a.code}: có tiền bị giam thì cần ngày dự kiến về`);
    if (releaseOn && releaseOn < date) throw new Error(`${a.code}: ngày tiền giam về phải sau ngày chốt`);
    rows.push({ accountId: a.id, available: toMinor(avail, a.currency), reserved, releaseOn, note: str(f, `note_${a.id}`) || null });
  }
  if (!rows.length) throw new Error("Chưa nhập số dư khả dụng cho tài khoản nào");
  return { date, rows };
}

/** Lệch = số chốt thật − số dư sổ quỹ. 0 là khớp. */
export const closingDiff = (available: bigint, book: bigint) => available - book;
