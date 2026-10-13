// Màn 22 (GĐ3): payout trên DB — đối soát với đơn, ghi tiền về vào Sổ quỹ ("Thu từ shop").
import { audit } from "./audit";
import { bizDateStr } from "./dates";
import type { Tx } from "./db";
import { lookupFxRate, postCashTxn } from "./ledger";
import { divRound, rateToScaled, toVnd } from "./money";
import { reconcilePayout, type ReconcileResult } from "./payout";

export type PayoutLineInput = { externalOrderId: string | null; amountUsd: number; kind: string };

const KINDS = ["ORDER", "FEE", "REFUND", "ADJUST"];
const c2 = (v: number) => Math.round(v * 100) / 100;

/** Dòng payout dán từ báo cáo sàn: orderId,amountUsd,kind (kind tuỳ chọn, mặc định ORDER). */
export function parsePayoutLines(rows: string[][]): PayoutLineInput[] {
  if (rows.length < 2) return [];
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const io = h.indexOf("orderid");
  const ia = h.indexOf("amountusd");
  const ik = h.indexOf("kind");
  if (ia < 0) throw new Error("Thiếu cột amountUsd (và orderId, kind)");
  return rows.slice(1).map((r, i) => {
    const amt = Number((r[ia] ?? "").replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
    if (!Number.isFinite(amt)) throw new Error(`Dòng ${i + 2}: số tiền "${r[ia]}" không hợp lệ`);
    const kind = ((ik >= 0 ? r[ik] : "") || "ORDER").trim().toUpperCase();
    if (!KINDS.includes(kind)) throw new Error(`Dòng ${i + 2}: kind phải là ${KINDS.join("/")}`);
    return { externalOrderId: io >= 0 ? (r[io] ?? "").trim() || null : null, amountUsd: c2(amt), kind };
  });
}

export type PayoutInput = {
  shopId: string;
  accountId?: string | null;
  periodFrom: Date;
  periodTo: Date;
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
  arrivedAt: Date | null;
  lines: PayoutLineInput[];
  actorId: string;
};

/** Tạo payout + dòng, ghép dòng với đơn của shop, đối soát. Trong ngưỡng 1% thì đánh dấu đã đối soát. */
export async function createPayout(tx: Tx, i: PayoutInput): Promise<{ payoutId: string; result: ReconcileResult }> {
  const shop = await tx.shop.findUniqueOrThrow({ where: { id: i.shopId } });
  const accountId = i.accountId || shop.payoutAccountId;
  if (!accountId) throw new Error(`Shop ${shop.code} chưa có tài khoản nhận tiền — khai ở màn 16`);
  if (i.periodTo < i.periodFrom) throw new Error("Kỳ payout không hợp lệ");
  const ids = i.lines.map((l) => l.externalOrderId).filter((x): x is string => !!x);
  const orders = await tx.order.findMany({ where: { shopId: shop.id, externalId: { in: ids } }, select: { id: true, externalId: true } });
  const orderBy = new Map(orders.map((o) => [o.externalId, o.id]));

  const result = reconcilePayout(
    { id: "new", grossUsd: i.grossUsd, feeUsd: i.feeUsd, netUsd: i.netUsd },
    i.lines.map((l) => ({ orderId: l.externalOrderId, amountUsd: l.amountUsd, kind: l.kind })),
    new Set(orderBy.keys()),
  );
  const p = await tx.payout.create({
    data: {
      accountId,
      shopId: shop.id,
      channel: shop.channel,
      periodFrom: i.periodFrom,
      periodTo: i.periodTo,
      grossUsd: c2(i.grossUsd),
      feeUsd: c2(i.feeUsd),
      netUsd: c2(i.netUsd),
      arrivedAt: i.arrivedAt,
      reconciled: result.withinTolerance,
      lines: {
        create: i.lines.map((l) => ({
          externalOrderId: l.externalOrderId,
          orderId: l.externalOrderId ? orderBy.get(l.externalOrderId) ?? null : null,
          amountUsd: l.amountUsd,
          kind: l.kind,
        })),
      },
    },
  });
  await audit(tx, { actorId: i.actorId, tableName: "Payout", recordId: p.id, action: "CREATE", after: { ...p, result } });
  return { payoutId: p.id, result: { ...result, payoutId: p.id } };
}

/**
 * Tiền về: ghi giao dịch "Thu từ shop" vào tài khoản nhận (doanh thu của kênh shop). Tài khoản USD ghi
 * đúng số đô; tài khoản VND quy theo tỷ giá ngày về (nhập hoặc tra bảng).
 */
export async function postPayout(tx: Tx, p: { payoutId: string; date?: Date | null; fxRate?: string | null; actorId: string }) {
  const payout = await tx.payout.findUniqueOrThrow({ where: { id: p.payoutId }, include: { account: true, shop: true } });
  if (payout.cashTxnId) throw new Error("Payout này đã ghi vào Sổ quỹ");
  if (!payout.shopId || !payout.shop) throw new Error("Payout chưa gắn shop");
  const date = p.date ?? payout.arrivedAt;
  if (!date) throw new Error("Nhập ngày tiền về");
  const cents = BigInt(Math.round(Number(payout.netUsd) * 100));
  if (cents <= 0n) throw new Error("Payout ròng không dương — không ghi được khoản thu");
  let amount: bigint;
  let fxRate: string | null = p.fxRate?.trim() || null;
  if (payout.account.currency === "USD") amount = cents;
  else {
    fxRate = fxRate ?? (await lookupFxRate(tx, date, "USD")).rate;
    amount = toVnd(cents, "USD", fxRate);
  }
  const txn = await postCashTxn(tx, {
    date,
    accountId: payout.accountId,
    direction: "IN",
    amount,
    fxRate: payout.account.currency === "USD" ? fxRate : null,
    shopIncome: true,
    shopId: payout.shopId,
    description: `Payout ${payout.shop.code} kỳ ${bizDateStr(payout.periodFrom)} → ${bizDateStr(payout.periodTo)}`,
    actorId: p.actorId,
  });
  await tx.payout.update({ where: { id: payout.id }, data: { cashTxnId: txn.id, arrivedAt: date } });
  return txn;
}

/** Doanh thu ròng đơn hàng đã ghi nhận và tiền thu từ shop đã về (USD) trong kỳ — cho cảnh báo CASH_GAP. */
export async function recognizedVsReceived(tx: Tx, from: Date, to: Date, rate: string | null) {
  const [orders, cash] = await Promise.all([
    tx.order.aggregate({ where: { orderedAt: { gte: from, lte: to }, status: { notIn: ["CANCELLED"] } }, _sum: { netUsd: true } }),
    tx.cashTxn.findMany({
      where: { voidedAt: null, direction: "IN", shopId: { not: null }, categoryId: null, date: { gte: from, lte: to }, journal: { source: "CASH_TXN" } },
      select: { currency: true, amount: true, amountVnd: true },
    }),
  ]);
  const receivedCents = cash.reduce((a, t) => {
    if (t.currency === "USD") return a + t.amount;
    return rate ? a + divRound(t.amountVnd * 100n * 1_000_000n, rateToScaled(rate)) : a;
  }, 0n);
  return { recognizedUsd: Number(orders._sum.netUsd ?? 0), receivedUsd: Number(receivedCents) / 100 };
}
