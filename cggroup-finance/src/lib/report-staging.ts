// Màn 31 — thu chi lịch sử từ file báo cáo tháng: vùng chờ (StagedTxn) → gắn shop / TK / hạng mục → chốt tháng
// = ghi CashTxn thật (postCashTxn, có bút toán) rồi khoá dòng. Đối chiếu: tổng ghi trong file vs tổng các dòng.
import { Prisma } from "@prisma/client";
import { audit } from "./audit";
import type { Tx } from "./db";
import { postCashTxn } from "./ledger";
import { divRound, rateToScaled, toVnd, type Currency } from "./money";
import type { DraftLine, ParsedReport, Section } from "./monthly-report";

export const sourceOf = (team: number, year: number, month: number) => `T${team}-${year}-${String(month).padStart(2, "0")}`;

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Ghép tên shop trong file với Shop: mã trong ngoặc "(NTT)", trùng mã, hoặc tên chứa nhau. */
export function matchShop(name: string | undefined, shops: { id: string; code: string; name: string }[]): string | null {
  if (!name) return null;
  const code = /\(([^)]+)\)/.exec(name)?.[1]?.trim().toUpperCase();
  if (code) {
    const byCode = shops.find((s) => s.code.toUpperCase() === code);
    if (byCode) return byCode.id;
  }
  const n = norm(name.replace(/\(.*?\)/g, ""));
  if (!n) return null;
  const exact = shops.find((s) => s.code.toLowerCase() === n.replace(/\s+/g, "") || norm(s.name.replace(/\(.*?\)/g, "")) === n);
  if (exact) return exact.id;
  const hits = shops.filter((s) => {
    const sn = norm(s.name.replace(/\(.*?\)/g, ""));
    return sn.length >= 3 && (sn.includes(n) || n.includes(sn));
  });
  return hits.length === 1 ? hits[0].id : null;
}

/** Đưa một file đã đọc vào vùng chờ. Đã có dòng của nguồn này: giữ nguyên (replace = xoá dòng chưa chốt rồi nạp lại). */
export async function stageReport(
  tx: Tx,
  p: { team: number; year: number; month: number; file: string; parsed: ParsedReport; replace?: boolean; actorId: string },
) {
  const source = sourceOf(p.team, p.year, p.month);
  const existing = await tx.stagedTxn.count({ where: { source } });
  if (existing) {
    if (!p.replace) return { source, added: 0, kept: existing };
    if (await tx.stagedTxn.count({ where: { source, status: "LOCKED" } })) throw new Error(`${source} đã có dòng chốt — không nạp lại được`);
    await tx.stagedTxn.deleteMany({ where: { source } });
  }
  const [accounts, shops, cats, sups, lastRate] = await Promise.all([
    tx.cashAccount.findMany({ select: { id: true, code: true } }),
    tx.shop.findMany({ select: { id: true, code: true, name: true } }),
    tx.expenseCategory.findMany({ select: { id: true, code: true } }),
    tx.supplier.findMany({ select: { id: true, code: true } }),
    tx.fxRate.findFirst({ where: { base: "USD", quote: "VND" }, orderBy: { date: "desc" } }),
  ]);
  const acc = new Map(accounts.map((a) => [a.code, a.id]));
  const cat = new Map(cats.map((c) => [c.code, c.id]));
  const sup = new Map(sups.map((s) => [s.code, s.id]));
  const rate = p.parsed.fxRate ?? (lastRate ? Number(lastRate.rate) : null);
  if (!rate) throw new Error(`${source}: không có tỷ giá — nhập tỷ giá USD ở Sổ quỹ trước`);

  await tx.stagedSource.upsert({
    where: { source },
    create: { source, team: `Team ${p.team}`, year: p.year, month: p.month, file: p.file, fxRate: rate, totals: p.parsed.totals, warnings: p.parsed.warnings },
    update: { file: p.file, fxRate: rate, totals: p.parsed.totals, warnings: p.parsed.warnings, stagedAt: new Date() },
  });
  const data = p.parsed.lines.map((l: DraftLine, i) => {
    const shopId = l.direction === "IN" ? matchShop(l.hint.shopName, shops) : null;
    return {
      source,
      team: `Team ${p.team}`,
      year: p.year,
      month: p.month,
      section: l.section,
      line: i + 1,
      label: l.label,
      ref: l.ref,
      date: l.date,
      direction: l.direction,
      amount: l.amount,
      currency: l.currency,
      fxRate: new Prisma.Decimal(rate),
      shopId,
      accountId: (l.hint.account && acc.get(l.hint.account)) || null,
      categoryId: l.direction === "OUT" && l.hint.category ? cat.get(l.hint.category) ?? null : null,
      supplierId: l.hint.supplier ? sup.get(l.hint.supplier) ?? null : null,
      incomeGl: l.direction === "IN" && !shopId ? l.hint.incomeGl ?? null : null,
      status: l.hint.skip ? "SKIP" : "DRAFT",
      note: [l.hint.skip, l.note, l.hint.shopName && !shopId ? `Shop trong file: ${l.hint.shopName} (chưa khớp shop nào)` : null].filter(Boolean).join(" · ") || null,
      updatedBy: p.actorId,
    };
  });
  await tx.stagedTxn.createMany({ data });
  return { source, added: data.length, kept: 0 };
}

const UNMATCHED = /Shop trong file: (.+?) \(chưa khớp shop nào\)/;

/** Tên shop trong file chưa khớp (để tạo ở màn 16), kèm số dòng & tổng USD. */
export function unmatchedShops(rows: { note: string | null; status: string; shopId: string | null; amount: bigint; currency: string; fxRate: unknown }[]) {
  const m = new Map<string, { rows: number; usd: number }>();
  for (const r of rows) {
    const name = r.status === "DRAFT" && !r.shopId ? UNMATCHED.exec(r.note ?? "")?.[1] : undefined;
    if (!name) continue;
    const v = m.get(name) ?? { rows: 0, usd: 0 };
    v.rows++;
    v.usd += toUsd(r.amount, r.currency, Number(r.fxRate));
    m.set(name, v);
  }
  return [...m].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.usd - a.usd);
}

/** Sau khi tạo shop ở màn 16: ghép lại các dòng thu chưa có shop (mọi nguồn chưa chốt). */
export async function rematchShops(tx: Tx, actorId: string) {
  const shops = await tx.shop.findMany({ select: { id: true, code: true, name: true } });
  const rows = await tx.stagedTxn.findMany({ where: { status: "DRAFT", direction: "IN", shopId: null, note: { contains: "chưa khớp shop" } } });
  let n = 0;
  for (const r of rows) {
    const shopId = matchShop(UNMATCHED.exec(r.note ?? "")?.[1], shops);
    if (!shopId) continue;
    await tx.stagedTxn.update({
      where: { id: r.id },
      data: { shopId, incomeGl: null, note: (r.note ?? "").replace(UNMATCHED, "Shop trong file: $1 (đã ghép)"), updatedBy: actorId },
    });
    n++;
  }
  return n;
}

// ─────────────────────────── đối chiếu

export type Recon = { key: string; label: string; fileUsd: number | null; linesUsd: number; diff: number | null };

const toUsd = (amount: bigint, currency: string, rate: number) => (currency === "USD" ? Number(amount) / 100 : Number(amount) / rate);

/** Tổng trong file vs tổng các dòng (bỏ dòng SKIP), quy USD theo tỷ giá của từng dòng. */
export function reconcile(totals: Record<string, number>, rows: { section: string; direction: string; amount: bigint; currency: string; fxRate: unknown; status: string }[]): Recon[] {
  const sum = (secs: Section[]) => rows.filter((r) => r.status !== "SKIP" && secs.includes(r.section as Section)).reduce((a, r) => a + toUsd(r.amount, r.currency, Number(r.fxRate)), 0);
  const thu = sum(["AMZ", "ETSY", "OTHER_IN"]);
  const chi = sum(["FIXED", "OPEX", "CHUNG", "FULFILL"]);
  const rows_: [string, string, number][] = [
    ["THU_AMZ", "Thu Amazon", sum(["AMZ"])],
    ["THU_ETSY", "Thu Etsy", sum(["ETSY"])],
    ["THU_KHAC", "Thu khác", sum(["OTHER_IN"])],
    ["THU", "TỔNG THU", thu],
    ["CHI_CO_DINH", "Chi cố định", sum(["FIXED"])],
    ["CHI_LUONG_SAN_CHUNG", "Lương, sàn, chi phí chung", sum(["OPEX", "CHUNG"])],
    ["CHI_FULFILL", "Fulfill", sum(["FULFILL"])],
    ["CHI", "TỔNG CHI", chi],
    ["LOI_NHUAN", "LỢI NHUẬN", thu - chi],
  ];
  return rows_.map(([key, label, linesUsd]) => {
    const f = totals[key];
    const fileUsd = typeof f === "number" ? f : null;
    return { key, label, fileUsd, linesUsd, diff: fileUsd === null ? null : linesUsd - fileUsd };
  });
}

// ─────────────────────────── lưu & chốt

export type RowEdit = {
  id: string;
  date?: Date;
  amount?: bigint;
  fxRate?: string;
  accountId?: string | null;
  shopId?: string | null;
  incomeGl?: string | null;
  categoryId?: string | null;
  supplierId?: string | null;
  skip?: boolean;
};

export async function saveRows(tx: Tx, edits: RowEdit[], actorId: string) {
  for (const e of edits) {
    const r = await tx.stagedTxn.findUniqueOrThrow({ where: { id: e.id } });
    if (r.status === "LOCKED") continue;
    await tx.stagedTxn.update({
      where: { id: r.id },
      data: {
        ...(e.date ? { date: e.date } : {}),
        ...(e.amount !== undefined ? { amount: e.amount } : {}),
        ...(e.fxRate ? { fxRate: new Prisma.Decimal(e.fxRate) } : {}),
        accountId: e.accountId ?? null,
        shopId: r.direction === "IN" ? e.shopId ?? null : null,
        incomeGl: r.direction === "IN" && !e.shopId ? e.incomeGl ?? null : null,
        categoryId: r.direction === "OUT" ? e.categoryId ?? null : null,
        supplierId: r.direction === "OUT" ? e.supplierId ?? null : null,
        status: e.skip ? "SKIP" : "DRAFT",
        updatedBy: actorId,
      },
    });
  }
}

/** Lỗi của một dòng trước khi chốt. */
export function rowErrors(r: { direction: string; accountId: string | null; shopId: string | null; incomeGl: string | null; categoryId: string | null; amount: bigint }): string[] {
  const e: string[] = [];
  if (r.amount <= 0n) e.push("số tiền");
  if (!r.accountId) e.push("tài khoản");
  if (r.direction === "IN" && !r.shopId && !r.incomeGl) e.push("shop hoặc TK ghi Có");
  if (r.direction === "OUT" && !r.categoryId) e.push("hạng mục");
  return e;
}

/** Quy số tiền dòng về đơn vị tiền của tài khoản. */
export function amountIn(accountCurrency: Currency, amount: bigint, currency: Currency, rate: string): bigint {
  if (accountCurrency === currency) return amount;
  if (accountCurrency === "VND") return toVnd(amount, "USD", rate); // cent USD → đồng
  return divRound(amount * 100n * 1_000_000n, rateToScaled(rate)); // đồng → cent USD
}

/**
 * Chốt: mọi dòng DRAFT của nguồn phải đủ (tài khoản; thu: shop hoặc TK ghi Có; chi: hạng mục) — thiếu một dòng
 * là không chốt dòng nào. Mỗi dòng → một giao dịch Sổ quỹ (tỷ giá của dòng), rồi khoá dòng.
 */
export async function commitSource(tx: Tx, p: { source: string; actorId: string }) {
  const rows = await tx.stagedTxn.findMany({ where: { source: p.source, status: "DRAFT" }, orderBy: { line: "asc" } });
  if (!rows.length) throw new Error("Không còn dòng nào chờ chốt");
  const bad = rows.map((r) => ({ r, e: rowErrors(r) })).filter((x) => x.e.length);
  if (bad.length) throw new Error(`Còn ${bad.length} dòng thiếu: ${bad.slice(0, 6).map((x) => `#${x.r.line} ${x.r.label} (${x.e.join(", ")})`).join("; ")}${bad.length > 6 ? "…" : ""}`);

  const accounts = new Map((await tx.cashAccount.findMany({ where: { id: { in: rows.map((r) => r.accountId!) } } })).map((a) => [a.id, a]));
  // tỷ giá tháng vào bảng FxRate (dự báo, tổng quan cần) nếu ngày đó chưa có
  const rates = new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r.fxRate.toString()]));
  for (const [d, rate] of rates) {
    const date = new Date(`${d}T00:00:00Z`);
    if (!(await tx.fxRate.findFirst({ where: { base: "USD", quote: "VND", date } }))) await tx.fxRate.create({ data: { date, base: "USD", quote: "VND", rate } });
  }
  let n = 0;
  for (const r of rows) {
    const acc = accounts.get(r.accountId!)!;
    const amount = amountIn(acc.currency as Currency, r.amount, r.currency as Currency, r.fxRate.toString());
    if (amount <= 0n) throw new Error(`#${r.line} ${r.label}: số tiền quy đổi bằng 0`);
    const txn = await postCashTxn(tx, {
      date: r.date,
      accountId: acc.id,
      direction: r.direction as "IN" | "OUT",
      amount,
      fxRate: acc.currency === "VND" ? null : r.fxRate.toString(),
      shopId: r.shopId,
      shopIncome: r.direction === "IN" && !!r.shopId,
      counterGl: r.direction === "IN" && !r.shopId ? r.incomeGl! : undefined,
      categoryId: r.direction === "OUT" ? r.categoryId : null,
      supplierId: r.supplierId,
      // nguồn bút toán mặc định CASH_TXN: dự báo, KPI, bản đồ tập trung đọc tiền shop theo nguồn này
      description: `${r.label} — báo cáo ${r.team} T${r.month}/${r.year}`,
      actorId: p.actorId,
    });
    await tx.stagedTxn.update({ where: { id: r.id }, data: { status: "LOCKED", cashTxnId: txn.id, lockedBy: p.actorId, lockedAt: new Date() } });
    n++;
  }
  await audit(tx, { actorId: p.actorId, tableName: "StagedSource", recordId: p.source, action: "UPDATE", after: { committed: n } });
  return n;
}
