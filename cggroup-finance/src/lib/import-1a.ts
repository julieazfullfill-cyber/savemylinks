// Nhập liệu từ bộ sheet giai đoạn 1a (đặc tả GĐ1 mục 04). Tên cột = tên trường DB, nên mỗi sheet
// chỉ là một vòng lặp. Số tiền nhập theo đơn vị thường dùng (đồng, đô) — đổi sang minor unit ở đây.
// Chạy lại không nạp trùng: dòng giống hệt một bản ghi đã có (cùng ngày, tài khoản, số tiền, diễn giải…) bị bỏ qua.
import { parseBizDate } from "./dates";
import type { Tx } from "./db";
import { approveExpense, createExpense } from "./expenses";
import { postCashTxn } from "./ledger";
import { toMinor, type Currency } from "./money";
import { createBill } from "./payables";

export const SHEETS = {
  GD_Tien: ["date", "accountCode", "direction", "amount", "currency", "fxRate", "categoryCode", "supplierCode", "shopCode", "description"],
  Chi_Phi: ["date", "categoryCode", "supplierCode", "amount", "currency", "description", "status"],
  So_Du: ["date", "accountCode", "available", "reserved", "releaseOn", "note"],
  HD_NCC: ["supplierCode", "billNo", "issueDate", "dueDate", "amount", "currency"],
} as const;
export type SheetName = keyof typeof SHEETS;

/** Cột bắt buộc của từng sheet; cột còn lại tuỳ chọn. */
const REQUIRED: Record<SheetName, string[]> = {
  GD_Tien: ["date", "accountCode", "direction", "amount", "description"],
  Chi_Phi: ["date", "categoryCode", "amount", "description"],
  So_Du: ["date", "accountCode", "available"],
  HD_NCC: ["supplierCode", "issueDate", "amount"],
};

export type CsvRow = { line: number; cells: Record<string, string> };

/** CSV/TSV dán từ Google Sheets: dòng đầu là tiêu đề (tên cột), phân cách bằng tab, dấu phẩy hoặc chấm phẩy. */
export function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("Cần dòng tiêu đề và ít nhất một dòng dữ liệu");
  const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  const split = (l: string) => {
    // hỗ trợ "ô có, dấu phẩy" trong ngoặc kép
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') {
        if (q && l[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (ch === sep && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const headers = split(lines[0]);
  const rows = lines.slice(1).map((l, i) => {
    const c = split(l);
    return { line: i + 2, cells: Object.fromEntries(headers.map((h, j) => [h, c[j] ?? ""])) };
  });
  return { headers, rows };
}

export function checkHeaders(sheet: SheetName, headers: string[]) {
  const missing = REQUIRED[sheet].filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`Sheet ${sheet} thiếu cột: ${missing.join(", ")}`);
}

export type RowResult = { line: number; status: "ok" | "skip" | "error"; message: string };

type Lookups = {
  account: Map<string, { id: string; currency: Currency }>;
  category: Map<string, string>;
  supplier: Map<string, string>;
  shop: Map<string, string>;
};

async function loadLookups(tx: Tx): Promise<Lookups> {
  const [accounts, cats, sups, shops] = await Promise.all([
    tx.cashAccount.findMany(),
    tx.expenseCategory.findMany(),
    tx.supplier.findMany(),
    tx.shop.findMany(),
  ]);
  return {
    account: new Map(accounts.map((a) => [a.code.toUpperCase(), { id: a.id, currency: a.currency as Currency }])),
    category: new Map(cats.map((c) => [c.code.toUpperCase(), c.id])),
    supplier: new Map(sups.map((s) => [s.code.toUpperCase(), s.id])),
    shop: new Map(shops.map((s) => [s.code.toUpperCase(), s.id])),
  };
}

function need<T>(map: Map<string, T>, code: string | undefined, what: string): T {
  if (!code?.trim()) throw new Error(`Thiếu ${what}`);
  const v = map.get(code.trim().toUpperCase());
  if (v === undefined) throw new Error(`${what} "${code}" không có trong danh mục`);
  return v;
}
const opt = <T>(map: Map<string, T>, code: string | undefined, what: string) => (code?.trim() ? need(map, code, what) : null);
const cur = (s: string | undefined, fallback: Currency): Currency => {
  const c = (s?.trim() || fallback).toUpperCase();
  if (c !== "VND" && c !== "USD") throw new Error(`Loại tiền "${s}" không hợp lệ`);
  return c;
};

/**
 * Nạp một sheet. Mỗi dòng trả về ok / skip (trùng) / error kèm lý do — một dòng sai không dừng cả lô
 * (mỗi dòng nằm trong SAVEPOINT riêng). Xem trước = gọi trong transaction rồi huỷ ở tầng gọi.
 */
export async function importSheet(tx: Tx, sheet: SheetName, rows: CsvRow[], actorId: string): Promise<RowResult[]> {
  const L = await loadLookups(tx);
  const out: RowResult[] = [];
  for (const { line, cells } of rows) {
    await tx.$executeRawUnsafe("SAVEPOINT import_row");
    try {
      const r = await importRow(tx, sheet, L, cells, actorId);
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT import_row");
      out.push({ line, ...r });
    } catch (e) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT import_row");
      out.push({ line, status: "error", message: (e as Error).message });
    }
  }
  return out;
}

async function importRow(tx: Tx, sheet: SheetName, L: Lookups, c: Record<string, string>, actorId: string): Promise<Omit<RowResult, "line">> {
  if (sheet === "GD_Tien") {
    const acc = need(L.account, c.accountCode, "Tài khoản tiền");
    const currency = cur(c.currency, acc.currency);
    if (currency !== acc.currency) throw new Error(`Tài khoản ${c.accountCode} là ${acc.currency}, dòng ghi ${currency}`);
    const dir = (c.direction ?? "").toUpperCase();
    if (dir !== "IN" && dir !== "OUT") throw new Error("direction phải là IN hoặc OUT");
    const date = parseBizDate(c.date);
    const amount = toMinor(c.amount, currency);
    const description = c.description || "(nhập từ sheet)";
    const categoryId = opt(L.category, c.categoryCode, "Hạng mục");
    const shopId = opt(L.shop, c.shopCode, "Shop");
    const dup = await tx.cashTxn.findFirst({ where: { date, accountId: acc.id, direction: dir, amount, description, voidedAt: null } });
    if (dup) return { status: "skip", message: "Đã có giao dịch giống hệt — bỏ qua" };
    await postCashTxn(tx, {
      date,
      accountId: acc.id,
      direction: dir,
      amount,
      fxRate: c.fxRate?.trim() ? c.fxRate.replace(/[.\s]/g, "").replace(",", ".") : null,
      categoryId,
      supplierId: opt(L.supplier, c.supplierCode, "Nhà cung cấp"),
      shopId,
      shopIncome: dir === "IN" && !!shopId && !categoryId,
      description,
      actorId,
    });
    return { status: "ok", message: "Đã ghi giao dịch" };
  }

  if (sheet === "Chi_Phi") {
    const status = (c.status?.trim() || "DRAFT").toUpperCase();
    if (status === "PAID") throw new Error("Khoản đã trả: nhập ở sheet GD_Tien với hạng mục (tránh ghi chi phí hai lần)");
    if (status !== "DRAFT" && status !== "APPROVED") throw new Error("status phải là DRAFT hoặc APPROVED");
    const currency = cur(c.currency, "VND");
    const date = parseBizDate(c.date);
    const amount = toMinor(c.amount, currency);
    const categoryId = need(L.category, c.categoryCode, "Hạng mục");
    const description = c.description || "(nhập từ sheet)";
    const dup = await tx.expense.findFirst({ where: { date, categoryId, amount, description, status: { not: "REJECTED" } } });
    if (dup) return { status: "skip", message: "Đã có đề nghị chi giống hệt — bỏ qua" };
    const e = await createExpense(tx, { date, categoryId, supplierId: opt(L.supplier, c.supplierCode, "Nhà cung cấp"), amount, currency, description, requestedBy: actorId });
    if (status === "APPROVED") await approveExpense(tx, { id: e.id, actorId, actorRole: "ADMIN" });
    return { status: "ok", message: status === "APPROVED" ? "Đã ghi và duyệt" : "Đã ghi (chờ duyệt)" };
  }

  if (sheet === "So_Du") {
    const acc = need(L.account, c.accountCode, "Tài khoản tiền");
    const date = parseBizDate(c.date);
    const reserved = c.reserved?.trim() ? toMinor(c.reserved, acc.currency) : 0n;
    const releaseOn = c.releaseOn?.trim() ? parseBizDate(c.releaseOn) : null;
    if (reserved > 0n && !releaseOn) throw new Error("Có tiền bị giam thì cần releaseOn");
    const data = { available: toMinor(c.available, acc.currency), reserved, releaseOn, note: c.note || null };
    await tx.accountBalance.upsert({ where: { accountId_date: { accountId: acc.id, date } }, create: { accountId: acc.id, date, ...data }, update: data });
    return { status: "ok", message: "Đã chốt số dư" };
  }

  const supplierId = need(L.supplier, c.supplierCode, "Nhà cung cấp");
  const currency = cur(c.currency, "USD");
  const issueDate = parseBizDate(c.issueDate);
  const amount = toMinor(c.amount, currency);
  const dup = await tx.supplierBill.findFirst({ where: c.billNo?.trim() ? { supplierId, billNo: c.billNo.trim() } : { supplierId, issueDate, amount } });
  if (dup) return { status: "skip", message: "Hoá đơn đã có — bỏ qua" };
  await createBill(tx, { supplierId, billNo: c.billNo?.trim() || null, issueDate, dueDate: c.dueDate?.trim() ? parseBizDate(c.dueDate) : null, amount, currency, actorId });
  return { status: "ok", message: "Đã ghi nhận hoá đơn" };
}
