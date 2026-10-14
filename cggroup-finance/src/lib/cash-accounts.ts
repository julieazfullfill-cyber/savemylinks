import type { Tx } from "./db";

/**
 * Tài khoản tiền thuộc một nhóm (Payoneer, Airwallex, PingPong…):
 * loại luôn theo nhóm; TK kế toán để trống thì lấy TK mặc định của nhóm.
 */
export async function applyProviderDefaults<T extends { providerId?: unknown; glAccount?: unknown; kind?: unknown }>(tx: Tx, data: T): Promise<T> {
  if (!data.providerId) throw new Error("Chọn nhóm cho tài khoản tiền");
  const provider = await tx.cashProvider.findUniqueOrThrow({ where: { id: String(data.providerId) } });
  return { ...data, kind: provider.kind, glAccount: data.glAccount || provider.glAccount };
}

/**
 * Số chỗ đã dùng tài khoản theo đơn vị tiền của nó (giao dịch, số dư chốt, payout). > 0 thì không đổi
 * loại tiền được: số tiền lưu theo đơn vị nhỏ nhất (USD = cent, VND = đồng) — đổi sẽ sai lệch 100 lần.
 */
export async function cashAccountUsage(tx: Tx, accountId: string): Promise<number> {
  const [txns, closes, payouts] = await Promise.all([
    tx.cashTxn.count({ where: { accountId } }),
    tx.accountBalance.count({ where: { accountId } }),
    tx.payout.count({ where: { accountId } }),
  ]);
  return txns + closes + payouts;
}
