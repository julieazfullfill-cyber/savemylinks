// Quy ước 01: tiền là số nguyên ở đơn vị nhỏ nhất. VND = đồng, USD = cent.
// Mọi phép tính ở file này dùng BigInt; không bao giờ đi qua Number/float.

export type Currency = "VND" | "USD";

/** Số chữ số thập phân của minor unit. */
export const MINOR_DIGITS: Record<Currency, number> = { VND: 0, USD: 2 };

/** Tỷ giá lưu Decimal(18,6) → so sánh/nhân bằng số nguyên đã nhân 1e6. */
const RATE_SCALE = 1_000_000n;

/**
 * Chuyển số người nhập ("1.250.000", "12.5", "12,50") sang minor unit.
 * Với VND, dấu . và , đều là phân cách hàng nghìn. Với USD, ký tự . hoặc ,
 * cuối cùng là phần thập phân nếu theo sau tối đa 2 chữ số.
 */
export function toMinor(input: string | number, currency: Currency): bigint {
  let s = String(input).trim().replace(/\s|_/g, "");
  if (!s) throw new Error("Số tiền trống");
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  const digits = MINOR_DIGITS[currency];
  let intPart = s;
  let frac = "";
  if (digits > 0) {
    const m = s.match(/^(.*)[.,](\d{1,2})$/);
    if (m) {
      intPart = m[1];
      frac = m[2];
    }
  }
  intPart = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(intPart || "0") || !/^\d*$/.test(frac)) {
    throw new Error(`Số tiền không hợp lệ: ${input}`);
  }
  const v = BigInt(intPart || "0") * 10n ** BigInt(digits) + BigInt(frac.padEnd(digits, "0") || "0");
  return neg ? -v : v;
}

/** Tỷ giá dạng chuỗi/Decimal → số nguyên đã nhân 1e6 (cắt sau 6 chữ số). */
export function rateToScaled(rate: string | number | { toString(): string }): bigint {
  const s = String(rate).trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`Tỷ giá không hợp lệ: ${s}`);
  return BigInt(m[1]) * RATE_SCALE + BigInt((m[2] ?? "").slice(0, 6).padEnd(6, "0"));
}

/** Chia làm tròn half-up cho số không âm hoặc âm (đối xứng). */
export function divRound(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  const q = (a * 2n + b) / (2n * b);
  return neg ? -q : q;
}

/**
 * Quy đổi minor unit nguyên tệ → đồng VND theo tỷ giá (VND cho 1 đơn vị nguyên tệ).
 * Ví dụ: 1250 cent × 25.400 = 317.500đ.
 */
export function toVnd(amountMinor: bigint, currency: Currency, rate: string | number | { toString(): string }): bigint {
  if (currency === "VND") return amountMinor;
  const scaled = rateToScaled(rate);
  const minorPerUnit = 10n ** BigInt(MINOR_DIGITS[currency]);
  return divRound(amountMinor * scaled, minorPerUnit * RATE_SCALE);
}

/** Nhân một số tiền với hệ số thực (kịch bản dự báo) — làm tròn half-up về đồng. */
export function mulFactor(v: bigint, factor: number): bigint {
  return divRound(v * BigInt(Math.round(factor * 1_000_000)), RATE_SCALE);
}

/** Hiển thị minor unit theo kiểu Việt Nam: 1.250.000 ₫ · 12,50 $ */
export function formatMoney(amountMinor: bigint | number | string, currency: Currency = "VND"): string {
  const v = BigInt(amountMinor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const digits = MINOR_DIGITS[currency];
  const base = 10n ** BigInt(digits);
  const intStr = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = digits ? "," + (abs % base).toString().padStart(digits, "0") : "";
  return `${neg ? "-" : ""}${intStr}${frac} ${currency === "VND" ? "₫" : "$"}`;
}
