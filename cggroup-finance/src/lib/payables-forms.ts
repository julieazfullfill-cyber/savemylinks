// Form màn hình 4 — hoá đơn NCC và trả tiền. Hàm thuần.
import { parseBizDate } from "./dates";
import { toMinor, type Currency } from "./money";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const rate = (f: FormData) => {
  const r = str(f, "fxRate").replace(/[.\s]/g, "").replace(",", ".");
  if (!r) return null;
  if (!/^\d+(\.\d+)?$/.test(r) || Number(r) < 1000 || Number(r) > 100000) throw new Error("Tỷ giá không hợp lệ (1.000–100.000)");
  return r;
};

export function parseBillForm(f: FormData) {
  const supplierId = str(f, "supplierId");
  if (!supplierId) throw new Error("Chọn nhà cung cấp");
  const currency = str(f, "currency") as Currency;
  if (currency !== "VND" && currency !== "USD") throw new Error("Chọn loại tiền");
  if (!str(f, "issueDate")) throw new Error("Thiếu ngày hoá đơn");
  if (!str(f, "amount")) throw new Error("Thiếu số tiền");
  const amount = toMinor(str(f, "amount"), currency);
  if (amount <= 0n) throw new Error("Số tiền phải lớn hơn 0");
  return {
    supplierId,
    billNo: str(f, "billNo") || null,
    issueDate: parseBizDate(str(f, "issueDate")),
    dueDate: str(f, "dueDate") ? parseBizDate(str(f, "dueDate")) : null,
    amount,
    currency,
    fxRate: currency === "USD" ? rate(f) : null,
    accountCode: str(f, "accountCode") || null,
    description: str(f, "description") || null,
  };
}

/** Trả tiền: số nhập theo tiền của tài khoản trả (`currency`). */
export function parsePayForm(f: FormData, currency: Currency) {
  const accountId = str(f, "accountId");
  if (!accountId) throw new Error("Chọn tài khoản trả");
  if (!str(f, "date")) throw new Error("Thiếu ngày trả");
  if (!str(f, "amount")) throw new Error("Thiếu số tiền trả");
  const amount = toMinor(str(f, "amount"), currency);
  if (amount <= 0n) throw new Error("Số tiền trả phải lớn hơn 0");
  return {
    accountId,
    date: parseBizDate(str(f, "date")),
    amount,
    fxRate: currency === "USD" ? rate(f) : null,
    settle: f.get("settle") === "on",
  };
}
