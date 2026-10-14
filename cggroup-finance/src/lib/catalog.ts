// Cấu hình màn hình 8 — Danh mục & người dùng. Mỗi danh mục khai báo trường một lần;
// trang, form và server action đều đọc từ đây. Không có nút xoá: ngưng dùng bằng `active`.
import { parseBizDate } from "./dates";
import { toMinor } from "./money";

export type RefSource = "account" | "assetAccount" | "entity" | "user" | "provider" | "design" | "product";

export type Field = {
  name: string;
  label: string;
  type: "text" | "email" | "int" | "bool" | "select" | "ref" | "date" | "vnd" | "password";
  required?: boolean;
  /** Không sửa được sau khi tạo (mã tài khoản, loại tiền…). */
  immutable?: boolean;
  /** Sửa được cho tới khi bản ghi đã được dùng (VD loại tiền của tài khoản đã có giao dịch). */
  lockWhenUsed?: boolean;
  options?: readonly string[];
  /** Nhãn hiển thị cho từng option (mặc định là chính mã). */
  optionLabels?: Record<string, string>;
  ref?: RefSource;
  min?: number;
  max?: number;
  help?: string;
  /** Mặc định khi tạo mới. */
  default?: string | boolean;
  /** Ẩn khỏi bảng danh sách. */
  hideInList?: boolean;
};

export type Catalog = {
  key: string;
  label: string;
  model: "account" | "cashProvider" | "cashAccount" | "expenseCategory" | "supplier" | "shop" | "legalEntity" | "user" | "design" | "product" | "variant";
  table: string;
  idField: "id" | "code";
  fields: Field[];
};

export const ACCOUNT_KINDS = ["EWALLET", "BANK", "PLATFORM", "CASH"] as const;
export const KIND_LABELS: Record<string, string> = { EWALLET: "Ví điện tử", BANK: "Ngân hàng", PLATFORM: "Số dư trên sàn", CASH: "Tiền mặt" };

const active: Field = { name: "active", label: "Đang dùng", type: "bool", default: true };
const code: Field = { name: "code", label: "Mã", type: "text", required: true, immutable: true };
const name: Field = { name: "name", label: "Tên", type: "text", required: true };

export const CATALOGS: Catalog[] = [
  {
    key: "tai-khoan-ke-toan",
    label: "Tài khoản kế toán",
    model: "account",
    table: "Account",
    idField: "code",
    fields: [
      code,
      name,
      { name: "type", label: "Loại", type: "select", required: true, options: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "COGS", "EXPENSE", "OTHER"] },
    ],
  },
  {
    key: "nhom-tai-khoan-tien",
    label: "Nhóm tài khoản tiền",
    model: "cashProvider",
    table: "CashProvider",
    idField: "id",
    fields: [
      { ...code, help: "Ví dụ PAYONEER, AIRWALLEX, PINGPONG" },
      name,
      { name: "kind", label: "Loại", type: "select", required: true, options: ACCOUNT_KINDS, optionLabels: KIND_LABELS },
      { name: "glAccount", label: "TK kế toán mặc định", type: "ref", ref: "assetAccount", required: true, help: "Tài khoản tiền trong nhóm dùng TK này nếu không chọn riêng" },
      active,
    ],
  },
  {
    key: "tai-khoan-tien",
    label: "Tài khoản tiền",
    model: "cashAccount",
    table: "CashAccount",
    idField: "id",
    fields: [
      { name: "providerId", label: "Nhóm", type: "ref", ref: "provider", required: true },
      { name: "email", label: "Email tài khoản", type: "email", help: "Email đăng nhập ví — không trùng trong cùng nhóm" },
      { ...code, help: "Mã ngắn, ví dụ PO-SALES01" },
      name,
      { name: "currency", label: "Tiền tệ", type: "select", required: true, lockWhenUsed: true, options: ["VND", "USD"], help: "Đổi được khi tài khoản chưa có giao dịch / số dư chốt / payout" },
      { name: "glAccount", label: "TK kế toán", type: "ref", ref: "assetAccount", help: "Trống = theo nhóm" },
      { name: "entityId", label: "Pháp nhân", type: "ref", ref: "entity" },
      active,
    ],
  },
  {
    key: "hang-muc-chi-phi",
    label: "Hạng mục chi phí",
    model: "expenseCategory",
    table: "ExpenseCategory",
    idField: "id",
    fields: [
      code,
      name,
      { name: "accountCode", label: "TK kế toán", type: "ref", ref: "account", required: true },
      { name: "recurring", label: "Định kỳ", type: "bool", default: true },
      { name: "dueDay", label: "Ngày đến hạn", type: "int", min: 1, max: 31, help: "Ngày trong tháng — dự báo đặt khoản chi vào đúng tuần này" },
      { name: "budgetVnd", label: "Ngân sách/tháng (đ)", type: "vnd", help: "Số dự kiến cho dự báo và cảnh báo chi vượt" },
      active,
    ],
  },
  {
    key: "nha-cung-cap",
    label: "Nhà cung cấp",
    model: "supplier",
    table: "Supplier",
    idField: "id",
    fields: [
      code,
      name,
      { name: "service", label: "Dịch vụ", type: "select", options: ["FULFILL", "TOOL", "DICH_VU", "KHAC"] },
      { name: "prepaid", label: "Trả trước", type: "bool", default: true, help: "Bỏ chọn nếu được công nợ" },
      { name: "creditDays", label: "Số ngày công nợ", type: "int", min: 0, max: 365, default: "0" },
      active,
    ],
  },
  // Shop: chuyển sang màn 16 (GĐ3) — bắt buộc pháp nhân + tài khoản nhận tiền, đổi trạng thái có lịch sử.
  // GĐ3: design → sản phẩm → biến thể SKU. SKU trên đơn khớp biến thể thì biên lãi gom được theo design (màn 23).
  {
    key: "design",
    label: "Design",
    model: "design",
    table: "Design",
    idField: "id",
    fields: [code, name, { name: "niche", label: "Niche", type: "text", help: "wedding, birthday, custom photo…" }],
  },
  {
    key: "san-pham",
    label: "Sản phẩm",
    model: "product",
    table: "Product",
    idField: "id",
    fields: [
      { name: "sku", label: "SKU gốc", type: "text", required: true, immutable: true },
      name,
      { name: "designId", label: "Design", type: "ref", ref: "design" },
      { name: "type", label: "Loại", type: "select", options: ["TSHIRT", "HOODIE", "SWEATSHIRT", "ORNAMENT", "MUG", "POSTER", "OTHER"] },
      active,
    ],
  },
  {
    key: "bien-the-sku",
    label: "Biến thể SKU",
    model: "variant",
    table: "Variant",
    idField: "id",
    fields: [
      { name: "productId", label: "Sản phẩm", type: "ref", ref: "product", required: true },
      { name: "sku", label: "SKU", type: "text", required: true, immutable: true, help: "Đúng như SKU trên file đơn của sàn" },
      { name: "size", label: "Size", type: "text" },
      { name: "color", label: "Màu", type: "text" },
    ],
  },
  {
    key: "phap-nhan",
    label: "Pháp nhân",
    model: "legalEntity",
    table: "LegalEntity",
    idField: "id",
    fields: [
      code,
      name,
      { name: "kind", label: "Loại hình", type: "select", required: true, options: ["LLC", "HO_KINH_DOANH", "CONG_TY_TNHH"] },
      { name: "country", label: "Quốc gia", type: "text", required: true },
      { name: "taxCode", label: "Mã số thuế", type: "text" },
      { name: "renewalDate", label: "Ngày gia hạn", type: "date" },
      { name: "annualCostVnd", label: "Chi phí duy trì/năm (đ)", type: "vnd" },
      active,
    ],
  },
  {
    key: "nguoi-dung",
    label: "Người dùng",
    model: "user",
    table: "User",
    idField: "id",
    fields: [
      { name: "email", label: "Email", type: "email", required: true },
      name,
      { name: "role", label: "Vai trò", type: "select", required: true, options: ["ADMIN", "KE_TOAN", "QUAN_LY", "NHAN_VIEN"], default: "NHAN_VIEN" },
      { name: "password", label: "Mật khẩu", type: "password", hideInList: true, help: "Để trống khi sửa nếu không đổi. Tối thiểu 8 ký tự." },
      active,
    ],
  },
];

export const catalogByKey = (key: string) => CATALOGS.find((c) => c.key === key);

export type ParsedValue = string | number | boolean | bigint | Date | null;

/**
 * Đọc FormData theo cấu hình → object ghi DB. `isCreate=false` thì bỏ trường immutable
 * và bỏ password trống. Ném Error với thông báo tiếng Việt khi sai.
 */
export function parseCatalogForm(cat: Catalog, form: FormData, isCreate: boolean): Record<string, ParsedValue> {
  const out: Record<string, ParsedValue> = {};
  for (const f of cat.fields) {
    if (f.immutable && !isCreate) continue;
    const raw = String(form.get(f.name) ?? "").trim();
    if (f.type === "bool") {
      out[f.name] = form.get(f.name) === "on";
      continue;
    }
    if (!raw) {
      if (f.type === "password") {
        if (isCreate && f.required) throw new Error(`Thiếu ${f.label}`);
        continue;
      }
      if (f.required) throw new Error(`Thiếu ${f.label}`);
      out[f.name] = null;
      continue;
    }
    switch (f.type) {
      case "int": {
        if (!/^-?\d+$/.test(raw)) throw new Error(`${f.label} phải là số nguyên`);
        const n = Number(raw);
        if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          throw new Error(`${f.label} phải trong khoảng ${f.min}–${f.max}`);
        }
        out[f.name] = n;
        break;
      }
      case "select":
        if (!f.options?.includes(raw)) throw new Error(`${f.label} không hợp lệ`);
        out[f.name] = raw;
        break;
      case "date":
        out[f.name] = parseBizDate(raw);
        break;
      case "vnd": {
        const v = toMinor(raw, "VND");
        if (v < 0n) throw new Error(`${f.label} không được âm`);
        out[f.name] = v;
        break;
      }
      case "email":
        if (!/^[^\s@]+@[^\s@]+$/.test(raw)) throw new Error("Email không hợp lệ");
        out[f.name] = raw.toLowerCase();
        break;
      case "password":
        if (raw.length < 8) throw new Error("Mật khẩu tối thiểu 8 ký tự");
        out[f.name] = raw;
        break;
      default:
        out[f.name] = f.name === "code" ? raw.toUpperCase() : raw;
    }
  }
  // Ràng buộc chéo: NCC trả trước thì không có ngày công nợ.
  if (cat.model === "supplier" && out.prepaid === true) out.creditDays = 0;
  return out;
}
