// Form nhập nhanh màn hình 2 — Sổ quỹ. Hàm thuần, ném Error tiếng Việt.
import { parseBizDate } from "./dates";
import { toMinor, type Currency } from "./money";

/**
 * OUT      Chi — gắn hạng mục chi phí; shop tuỳ chọn (chi cho shop nào).
 * SHOP_IN  Thu từ shop — bắt buộc shop; doanh thu ghi theo kênh của shop.
 * IN       Thu khác — không từ shop (NCC hoàn tiền, góp vốn…), đối ứng 409.
 * OPENING  Số dư đầu kỳ.
 */
export type TxnKind = "OUT" | "SHOP_IN" | "IN" | "OPENING";
export const KIND_LABEL: Record<TxnKind, string> = {
  OUT: "Chi",
  SHOP_IN: "Thu từ shop",
  IN: "Thu khác",
  OPENING: "Số dư đầu kỳ",
};

/** Loại của một giao dịch đã ghi — suy ra từ dữ liệu, không lưu cột riêng. */
export function txnKind(t: { direction: "IN" | "OUT"; shopId: string | null; categoryId: string | null; journalSource?: string | null }): TxnKind {
  if (t.journalSource === "OPENING") return "OPENING";
  if (t.direction === "OUT") return "OUT";
  return t.shopId && !t.categoryId ? "SHOP_IN" : "IN";
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/** Phần không phụ thuộc tài khoản — đọc trước để biết tài khoản nào. */
export function readCashTxnHead(f: FormData) {
  const kind = str(f, "kind") as TxnKind;
  if (!(kind in KIND_LABEL)) throw new Error("Chọn loại giao dịch");
  const accountId = str(f, "accountId");
  if (!accountId) throw new Error("Chọn tài khoản tiền");
  return { kind, accountId };
}

/**
 * Số tiền nhập theo đơn vị thường dùng của tài khoản (đồng, đô) → minor unit.
 * Tỷ giá để trống với USD thì lúc ghi sẽ tra bảng FxRate theo ngày.
 * Trường không thuộc loại đang chọn bị bỏ qua (form ẩn chúng, nhưng không tin trình duyệt).
 */
export function parseCashTxnForm(f: FormData, currency: Currency) {
  const { kind, accountId } = readCashTxnHead(f);
  if (!str(f, "date")) throw new Error("Thiếu ngày");
  const date = parseBizDate(str(f, "date"));
  if (!str(f, "amount")) throw new Error("Thiếu số tiền");
  const amount = toMinor(str(f, "amount"), currency);
  if (amount <= 0n) throw new Error("Số tiền phải lớn hơn 0 — chọn Thu/Chi ở cột Loại");
  const description = str(f, "description");
  if (!description) throw new Error("Thiếu diễn giải");

  let fxRate: string | null = null;
  if (currency !== "VND" && str(f, "fxRate")) {
    fxRate = str(f, "fxRate").replace(/[.\s]/g, "").replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(fxRate) || Number(fxRate) <= 0) throw new Error("Tỷ giá không hợp lệ");
  }

  const shopId = kind === "SHOP_IN" || kind === "OUT" ? str(f, "shopId") || null : null;
  if (kind === "SHOP_IN" && !shopId) throw new Error("Thu từ shop: chọn kênh và shop");

  return {
    opening: kind === "OPENING",
    shopIncome: kind === "SHOP_IN",
    direction: (kind === "OUT" ? "OUT" : "IN") as "IN" | "OUT",
    accountId,
    date,
    amount,
    fxRate,
    categoryId: kind === "OUT" || kind === "IN" ? str(f, "categoryId") || null : null,
    supplierId: kind === "OUT" || kind === "IN" ? str(f, "supplierId") || null : null,
    shopId,
    description,
  };
}

/** Tỷ giá USD/VND nhập tay: "25.400" hoặc "25400,5" → chuỗi số thập phân. */
export function parseFxRateForm(f: FormData) {
  if (!str(f, "date")) throw new Error("Thiếu ngày tỷ giá");
  const date = parseBizDate(str(f, "date"));
  const raw = str(f, "rate");
  // "25.400" là nghìn kiểu VN; "25400,5" hoặc "25400.5" là thập phân.
  const norm = /^\d{1,3}(\.\d{3})+$/.test(raw) ? raw.replace(/\./g, "") : raw.replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,6})?$/.test(norm) || Number(norm) <= 0) throw new Error("Tỷ giá không hợp lệ");
  if (Number(norm) < 1000 || Number(norm) > 100000) throw new Error("Tỷ giá USD/VND phải trong khoảng 1.000–100.000 — kiểm tra lại số 0");
  return { date, rate: norm };
}
