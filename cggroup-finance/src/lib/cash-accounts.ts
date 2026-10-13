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
