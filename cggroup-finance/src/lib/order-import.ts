// Nhập đơn hàng từ CSV của Etsy / Amazon / Walmart / TikTok Shop / Website — đặc tả GĐ3 mục 06.
//
// Mỗi sàn đặt tên cột một kiểu và đổi theo thời gian, nên mỗi trường khai báo NHIỀU tên khả dĩ.
// Sàn đổi tên cột → chỉ thêm tên vào mảng, không sửa logic. Màn 20 hiện rõ cột nào không tìm thấy.
//
// Khác đặc tả:
//  - thêm WALMART (tên cột theo báo cáo Seller Center — cần đối chiếu file thật);
//  - đơn nhiều dòng sản phẩm được GỘP thành nhiều OrderItem (đặc tả bỏ dòng trùng — mục 11 dặn sửa):
//    cột tiền "cấp mặt hàng" (Item Total, item-price…) cộng dồn, cột "cấp đơn" lặp lại ở mỗi dòng
//    (Order Total…) chỉ lấy một lần;
//  - parseDate thử ISO, MM/DD/YYYY trước khi rơi về Date() — và trả ngày UTC.

import type { Channel } from "./payout";

export type NormalizedItem = { sku: string; qty: number; amountUsd: number };

export type NormalizedOrder = {
  externalId: string;
  orderedAt: string; // YYYY-MM-DD
  country: string | null;
  grossUsd: number;
  discountUsd: number;
  shippingChargedUsd: number;
  platformFeeUsd: number;
  taxUsd: number;
  netUsd: number;
  items: NormalizedItem[];
  /** dòng đầu tiên trong file của đơn này */
  row: number;
};

export type ImportError = { row: number; field: string; message: string; raw?: string };

type FieldMap = Record<string, string[]>;

export const COLUMN_MAPS: Record<Channel, FieldMap> = {
  ETSY: {
    externalId: ["Order ID", "Order Number"],
    orderedAt: ["Sale Date", "Date Paid", "Order Date"],
    country: ["Ship Country", "Country"],
    grossUsd: ["Order Value", "Item Total", "Order Total"],
    discountUsd: ["Discount Amount", "Coupon Details"],
    shippingChargedUsd: ["Shipping", "Shipping Value"],
    platformFeeUsd: ["Card Processing Fees", "Transaction Fees", "Fees"],
    taxUsd: ["Sales Tax", "Order Sales Tax", "VAT Paid by Buyer"],
    sku: ["SKU"],
    qty: ["Quantity", "Number of Items"],
  },
  AMAZON: {
    externalId: ["amazon-order-id", "order-id"],
    orderedAt: ["purchase-date", "payments-date"],
    country: ["ship-country", "ship-to-country"],
    grossUsd: ["item-price", "product sales", "ordered product sales"],
    discountUsd: ["item-promotion-discount", "promotional rebates"],
    shippingChargedUsd: ["shipping-price", "shipping credits"],
    platformFeeUsd: ["selling fees", "fba fees", "order fees"],
    taxUsd: ["item-tax", "sales tax collected"],
    sku: ["sku", "seller-sku"],
    qty: ["quantity-purchased", "quantity"],
  },
  WALMART: {
    externalId: ["PO#", "Purchase Order Number", "Customer Order #", "Customer Order Number"],
    orderedAt: ["Order Date", "PO Date"],
    country: ["Ship to Country", "Country"],
    grossUsd: ["Item Cost", "Unit Price", "Order Total"],
    discountUsd: ["Discount", "Promotion Discount"],
    shippingChargedUsd: ["Shipping Cost", "Shipping"],
    platformFeeUsd: ["Commission", "Commission Amount", "Referral Fee"],
    taxUsd: ["Tax", "Item Tax"],
    sku: ["SKU", "Item SKU"],
    qty: ["Qty", "Quantity"],
  },
  TIKTOK: {
    externalId: ["Order ID", "Order Number"],
    orderedAt: ["Created Time", "Paid Time", "Order Time"],
    country: ["Country", "Recipient Country"],
    grossUsd: ["SKU Subtotal Before Discount", "Order Amount", "Total Amount"],
    discountUsd: ["SKU Seller Discount", "Seller Discount"],
    shippingChargedUsd: ["Shipping Fee After Discount", "Original Shipping Fee"],
    platformFeeUsd: ["TikTok Shop Commission Fee", "Transaction Fee", "Platform Fee"],
    taxUsd: ["Taxes", "Sales Tax"],
    sku: ["Seller SKU", "SKU ID"],
    qty: ["Quantity"],
  },
  WEBSITE: {
    externalId: ["Name", "Order", "Id"],
    orderedAt: ["Created at", "Paid at"],
    country: ["Shipping Country", "Billing Country"],
    grossUsd: ["Subtotal", "Total"],
    discountUsd: ["Discount Amount"],
    shippingChargedUsd: ["Shipping"],
    platformFeeUsd: ["Fees"],
    taxUsd: ["Taxes"],
    sku: ["Lineitem sku"],
    qty: ["Lineitem quantity"],
  },
};

/** Cột tiền ở cấp MẶT HÀNG (mỗi dòng một số khác nhau) → cộng dồn khi một đơn có nhiều dòng. */
const ITEM_LEVEL = new Set(
  ["Item Total", "item-price", "item-promotion-discount", "shipping-price", "item-tax", "SKU Subtotal Before Discount", "SKU Seller Discount", "Item Cost", "Unit Price", "Item Tax", "Commission", "Commission Amount", "Referral Fee"].map(
    (s) => s.trim().toLowerCase(),
  ),
);

/** Parser CSV xử lý dấu nháy kép, dấu phẩy trong ô, xuống dòng trong ô, BOM. Tự nhận tab/chấm phẩy. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = firstLine.includes("\t") ? "\t" : firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function findColumn(header: string[], candidates: string[]): { index: number; name: string | null } {
  const h = header.map(norm);
  for (const c of candidates) {
    const i = h.indexOf(norm(c));
    if (i >= 0) return { index: i, name: norm(c) };
  }
  return { index: -1, name: null };
}

/** "$1,234.56" → 1234.56 ; "(12.00)" → -12 ; "" → 0. Làm tròn cent. */
export function parseMoney(raw: string | undefined): number {
  if (!raw) return 0;
  let s = raw.trim().replace(/[$€£\s]/g, "").replace(/USD/i, "").replace(/,/g, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) return 0;
  return Math.round((neg ? -n : n) * 100) / 100;
}

/** Nhận nhiều định dạng ngày của các sàn, trả về YYYY-MM-DD. Đặc tả: self-test bắt lỗi đảo tháng/ngày. */
export function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); // MM/DD/YYYY (định dạng Mỹ của các sàn)
  if (m) {
    const [mm, dd] = [Number(m[1]), Number(m[2])];
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  if (!/\d{4}/.test(s)) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

export type NormalizeResult = {
  orders: NormalizedOrder[];
  errors: ImportError[];
  /** cột khai báo trong COLUMN_MAPS nhưng không tìm thấy trong file */
  missingColumns: string[];
  /** cột đã khớp: trường → tên cột trong file */
  matchedColumns: Record<string, string>;
};

const MONEY_FIELDS = ["grossUsd", "discountUsd", "shippingChargedUsd", "platformFeeUsd", "taxUsd"] as const;

export function normalizeOrders(channel: Channel, rows: string[][]): NormalizeResult {
  const errors: ImportError[] = [];
  const orders: NormalizedOrder[] = [];
  if (rows.length < 2) {
    return { orders, errors: [{ row: 0, field: "-", message: "File rỗng hoặc chỉ có dòng tiêu đề" }], missingColumns: [], matchedColumns: {} };
  }
  const header = rows[0];
  const map = COLUMN_MAPS[channel];
  const col: Record<string, { index: number; name: string | null }> = {};
  const missingColumns: string[] = [];
  const matchedColumns: Record<string, string> = {};
  for (const [field, candidates] of Object.entries(map)) {
    col[field] = findColumn(header, candidates);
    if (col[field].index < 0) missingColumns.push(field);
    else matchedColumns[field] = header[col[field].index].trim();
  }
  for (const required of ["externalId", "orderedAt", "grossUsd"]) {
    if (col[required].index < 0) {
      errors.push({ row: 0, field: required, message: `Không tìm thấy cột cho "${required}". Tên khả dĩ: ${map[required].join(", ")}` });
    }
  }
  if (errors.length) return { orders, errors, missingColumns, matchedColumns };

  const get = (r: string[], f: string) => (col[f].index >= 0 ? r[col[f].index] : undefined);
  const byId = new Map<string, NormalizedOrder>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const externalId = (get(r, "externalId") ?? "").trim();
    if (!externalId) {
      errors.push({ row: line, field: "externalId", message: "Thiếu mã đơn" });
      continue;
    }
    const sku = (get(r, "sku") ?? "").trim();
    const qty = Math.max(1, Math.round(parseMoney(get(r, "qty")) || 1));
    const amounts = Object.fromEntries(MONEY_FIELDS.map((f) => [f, Math.abs(parseMoney(get(r, f)))])) as Record<(typeof MONEY_FIELDS)[number], number>;
    amounts.shippingChargedUsd = parseMoney(get(r, "shippingChargedUsd"));

    const existing = byId.get(externalId);
    if (existing) {
      // dòng sản phẩm tiếp theo của cùng đơn: cộng cột cấp mặt hàng, bỏ qua cột cấp đơn lặp lại
      for (const f of MONEY_FIELDS) if (col[f].name && ITEM_LEVEL.has(col[f].name!)) existing[f] = Math.round((existing[f] + amounts[f]) * 100) / 100;
      existing.items.push({ sku: sku || "(không SKU)", qty, amountUsd: amounts.grossUsd });
      continue;
    }

    const orderedAt = parseDate(get(r, "orderedAt"));
    if (!orderedAt) {
      errors.push({ row: line, field: "orderedAt", message: "Ngày không đọc được", raw: get(r, "orderedAt") });
      continue;
    }
    const o: NormalizedOrder = {
      externalId,
      orderedAt,
      country: (get(r, "country") ?? "").trim() || null,
      ...amounts,
      netUsd: 0,
      items: [{ sku: sku || "(không SKU)", qty, amountUsd: amounts.grossUsd }],
      row: line,
    };
    byId.set(externalId, o);
    orders.push(o);
  }

  for (const o of orders) {
    o.netUsd = Math.round((o.grossUsd - o.discountUsd + o.shippingChargedUsd - o.platformFeeUsd - o.taxUsd) * 100) / 100;
    if (o.grossUsd === 0) errors.push({ row: o.row, field: "grossUsd", message: "Doanh thu bằng 0 — kiểm tra tên cột hoặc ô dữ liệu", raw: undefined });
  }
  return { orders, errors, missingColumns, matchedColumns };
}
