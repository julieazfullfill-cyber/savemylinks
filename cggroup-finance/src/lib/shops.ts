// Màn 16–19 (GĐ3): shop, sức khoẻ shop, tập trung dòng tiền, nhà cung cấp & bảng giá, nghĩa vụ pháp nhân.
import { audit } from "./audit";
import { CHANNEL_CODES } from "./channels";
import { addDays, bizDateStr } from "./dates";
import type { Tx } from "./db";

export const SHOP_STATUSES = ["ACTIVE", "UNDER_REVIEW", "SUSPENDED", "DEACTIVATED", "CLOSED"] as const;
export type ShopStatus = (typeof SHOP_STATUSES)[number];
export const SHOP_STATUS_LABEL: Record<ShopStatus, string> = {
  ACTIVE: "Đang bán",
  UNDER_REVIEW: "Đang bị xem xét",
  SUSPENDED: "Bị treo",
  DEACTIVATED: "Bị khoá",
  CLOSED: "Đã đóng",
};
/** Trạng thái "có sự cố" — dùng để đếm tần suất bị treo. */
export const TROUBLE: ShopStatus[] = ["UNDER_REVIEW", "SUSPENDED", "DEACTIVATED"];

export type ShopInput = {
  code: string;
  name: string;
  channel: string;
  entityId: string | null;
  payoutAccountId: string | null;
  ownerId: string | null;
  openedAt: Date | null;
  actorId: string;
};

/** Tạo / sửa shop. Đặc tả màn 16: không cho tạo shop thiếu pháp nhân (và tài khoản nhận tiền). */
export async function saveShop(tx: Tx, id: string | null, i: ShopInput) {
  if (!i.code.trim() || !i.name.trim()) throw new Error("Thiếu mã hoặc tên shop");
  if (!(CHANNEL_CODES as string[]).includes(i.channel)) throw new Error("Kênh không hợp lệ");
  if (!i.entityId) throw new Error("Shop phải thuộc một pháp nhân — tạo pháp nhân ở màn 8 trước");
  if (!i.payoutAccountId) throw new Error("Chọn tài khoản nhận tiền của shop");
  const data = {
    code: i.code.trim().toUpperCase(),
    name: i.name.trim(),
    channel: i.channel,
    entityId: i.entityId,
    payoutAccountId: i.payoutAccountId,
    ownerId: i.ownerId,
    openedAt: i.openedAt,
  };
  if (id) {
    const before = await tx.shop.findUniqueOrThrow({ where: { id } });
    const after = await tx.shop.update({ where: { id }, data });
    await audit(tx, { actorId: i.actorId, tableName: "Shop", recordId: id, action: "UPDATE", before, after });
    return after;
  }
  const after = await tx.shop.create({ data });
  await audit(tx, { actorId: i.actorId, tableName: "Shop", recordId: after.id, action: "CREATE", after });
  return after;
}

/** Đổi trạng thái shop — luôn ghi một ShopHealthEvent (màn 18 đọc lịch sử này). */
export async function changeShopStatus(tx: Tx, p: { shopId: string; toStatus: string; at: Date; note: string | null; actorId: string }) {
  if (!(SHOP_STATUSES as readonly string[]).includes(p.toStatus)) throw new Error("Trạng thái shop không hợp lệ");
  const shop = await tx.shop.findUniqueOrThrow({ where: { id: p.shopId } });
  if (shop.status === p.toStatus) throw new Error("Shop đã ở trạng thái này");
  await tx.shopHealthEvent.create({
    data: { shopId: shop.id, at: p.at, fromStatus: shop.status, toStatus: p.toStatus, note: p.note, createdBy: p.actorId },
  });
  const after = await tx.shop.update({ where: { id: shop.id }, data: { status: p.toStatus } });
  await audit(tx, { actorId: p.actorId, tableName: "Shop", recordId: shop.id, action: "UPDATE", before: shop, after });
  return after;
}

/**
 * Tần suất gặp sự cố (chuyển sang UNDER_REVIEW / SUSPENDED / DEACTIVATED) theo một khoá
 * (kênh, người phụ trách…), kèm số shop để tính tỷ lệ. Hàm thuần.
 */
export function troubleStats(
  shops: { id: string; key: string }[],
  events: { shopId: string; toStatus: string }[],
): { key: string; shops: number; incidents: number; perShop: number }[] {
  const keyOf = new Map(shops.map((s) => [s.id, s.key]));
  const acc = new Map<string, { shops: number; incidents: number }>();
  for (const s of shops) acc.set(s.key, { shops: (acc.get(s.key)?.shops ?? 0) + 1, incidents: acc.get(s.key)?.incidents ?? 0 });
  for (const e of events) {
    if (!(TROUBLE as string[]).includes(e.toStatus)) continue;
    const k = keyOf.get(e.shopId);
    if (k === undefined) continue;
    acc.get(k)!.incidents++;
  }
  return [...acc.entries()]
    .map(([key, v]) => ({ key, ...v, perShop: v.shops ? v.incidents / v.shops : 0 }))
    .sort((a, b) => b.incidents - a.incidents);
}

// ------------------------------------------------------------------ bảng giá NCC

/** Giá mới = bản ghi mới; giá đang mở của cùng NCC + SKU tự đóng vào hôm trước (EXCLUDE ở DB chặn chồng). */
export async function addSupplierPrice(tx: Tx, p: { supplierId: string; sku: string; priceUsd: number; effectiveFrom: Date; actorId: string }) {
  const sku = p.sku.trim().toUpperCase();
  if (!sku) throw new Error("Thiếu SKU");
  if (!(p.priceUsd > 0)) throw new Error("Giá phải lớn hơn 0");
  const latest = await tx.supplierPrice.findFirst({ where: { supplierId: p.supplierId, sku }, orderBy: { effectiveFrom: "desc" } });
  if (latest && p.effectiveFrom <= latest.effectiveFrom) {
    throw new Error(`Ngày hiệu lực phải sau giá gần nhất (${bizDateStr(latest.effectiveFrom)})`);
  }
  if (latest && latest.effectiveTo === null) {
    await tx.supplierPrice.update({ where: { id: latest.id }, data: { effectiveTo: addDays(p.effectiveFrom, -1) } });
  }
  const row = await tx.supplierPrice.create({ data: { supplierId: p.supplierId, sku, priceUsd: p.priceUsd, effectiveFrom: p.effectiveFrom } });
  await audit(tx, { actorId: p.actorId, tableName: "SupplierPrice", recordId: row.id, action: "CREATE", after: row });
  return row;
}

/** Giá bảng giá của NCC cho SKU vào ngày `on` (null nếu chưa có). */
export async function listedPrice(tx: Tx, supplierId: string, sku: string | null, on: Date): Promise<number | null> {
  if (!sku) return null;
  const p = await tx.supplierPrice.findFirst({
    where: { supplierId, sku: sku.trim().toUpperCase(), effectiveFrom: { lte: on }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }] },
    orderBy: { effectiveFrom: "desc" },
  });
  return p ? Number(p.priceUsd) : null;
}

// ------------------------------------------------------------- tập trung dòng tiền

/**
 * Tiền thu từ shop trong [from, to] theo tài khoản nhận (quy VND theo tỷ giá ngày giao dịch).
 * Màn 17 và cảnh báo CONCENTRATION dùng tỷ trọng này.
 */
export async function incomeByAccount(tx: Tx, from: Date, to: Date) {
  const rows = await tx.cashTxn.groupBy({
    by: ["accountId"],
    where: { voidedAt: null, direction: "IN", shopId: { not: null }, categoryId: null, date: { gte: from, lte: to }, journal: { source: "CASH_TXN" } },
    _sum: { amountVnd: true },
  });
  const accounts = await tx.cashAccount.findMany({ where: { id: { in: rows.map((r) => r.accountId) } }, include: { provider: true } });
  const total = rows.reduce((a, r) => a + (r._sum.amountVnd ?? 0n), 0n);
  return rows
    .map((r) => {
      const a = accounts.find((x) => x.id === r.accountId)!;
      const vnd = r._sum.amountVnd ?? 0n;
      return { accountId: a.id, code: a.code, name: `${a.provider.name} · ${a.email ?? a.name}`, vnd, share: total > 0n ? Number((vnd * 10_000n) / total) / 10_000 : 0 };
    })
    .sort((a, b) => (b.vnd > a.vnd ? 1 : b.vnd < a.vnd ? -1 : 0));
}

// ------------------------------------------------------------- nghĩa vụ pháp nhân

export const FILING_KINDS: Record<string, string> = {
  ANNUAL_REPORT: "Báo cáo năm",
  RENEWAL: "Gia hạn pháp nhân",
  TAX_5472: "Thuế Form 5472 (LLC Mỹ)",
  TAX_HKD: "Thuế hộ kinh doanh",
};

export async function addFiling(tx: Tx, p: { entityId: string; kind: string; dueDate: Date; amountVnd: bigint | null; actorId: string }) {
  if (!FILING_KINDS[p.kind]) throw new Error("Loại nghĩa vụ không hợp lệ");
  if (p.amountVnd !== null && p.amountVnd < 0n) throw new Error("Số tiền không được âm");
  const row = await tx.entityFiling.create({ data: { entityId: p.entityId, kind: p.kind, dueDate: p.dueDate, amountVnd: p.amountVnd } });
  await audit(tx, { actorId: p.actorId, tableName: "EntityFiling", recordId: row.id, action: "CREATE", after: row });
  return row;
}

export async function completeFiling(tx: Tx, p: { id: string; on: Date; actorId: string }) {
  const before = await tx.entityFiling.findUniqueOrThrow({ where: { id: p.id } });
  if (before.status === "DONE") throw new Error("Đã hoàn thành");
  const after = await tx.entityFiling.update({ where: { id: p.id }, data: { status: "DONE", completedAt: p.on } });
  await audit(tx, { actorId: p.actorId, tableName: "EntityFiling", recordId: p.id, action: "UPDATE", before, after });
  return after;
}
