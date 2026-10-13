// Màn 24 — bút toán điều chỉnh nhập tay (khấu hao, phân loại lại, trích trước…). Không sửa, không xoá:
// sai thì "Đảo bút toán". Không cho ghi tay vào TK có sổ chi tiết riêng — sổ quỹ (TK tiền),
// phải thu 131, phải trả 201, lợi nhuận giữ lại 302 — vì sẽ lệch với sổ chi tiết đó.
import { audit } from "./audit";
import type { Tx } from "./db";
import { createJournal, postingDateFor } from "./journal";
import { assertBalanced, reverseLines, type LineDraft } from "./ledger";

export const SUBLEDGER_GL = ["131", "201", "302"];
/** Số dòng của form bút toán tay. */
export const MANUAL_ROWS = 6;

/** TK không được ghi tay: TK tiền của mọi tài khoản / nhóm tài khoản + TK có sổ chi tiết. */
export async function lockedAccounts(tx: Tx): Promise<Set<string>> {
  const [acc, prov] = await Promise.all([tx.cashAccount.findMany({ select: { glAccount: true } }), tx.cashProvider.findMany({ select: { glAccount: true } })]);
  return new Set([...acc.map((a) => a.glAccount), ...prov.map((p) => p.glAccount), ...SUBLEDGER_GL]);
}

export async function postManualJournal(tx: Tx, p: { date: Date; memo: string; lines: LineDraft[]; actorId: string }) {
  if (!p.memo.trim()) throw new Error("Ghi diễn giải cho bút toán");
  const lines = p.lines.filter((l) => l.debitVnd > 0n || l.creditVnd > 0n);
  assertBalanced(lines);
  const locked = await lockedAccounts(tx);
  const bad = lines.filter((l) => locked.has(l.accountCode)).map((l) => l.accountCode);
  if (bad.length) throw new Error(`Không ghi tay vào TK ${[...new Set(bad)].join(", ")} — dùng Sổ quỹ / Công nợ / Đóng sổ`);
  const known = await tx.account.count({ where: { code: { in: lines.map((l) => l.accountCode) } } });
  if (known !== new Set(lines.map((l) => l.accountCode)).size) throw new Error("Có tài khoản không tồn tại");
  const j = await createJournal(tx, { data: { date: p.date, memo: p.memo.trim(), source: "MANUAL", createdBy: p.actorId, lines: { create: lines } } });
  await audit(tx, { actorId: p.actorId, tableName: "JournalEntry", recordId: j.id, action: "CREATE", after: { ...j, lines } });
  return j;
}

/** Đảo bút toán tay: bút toán ngược (kỳ đã đóng thì ghi hôm nay). */
export async function reverseManualJournal(tx: Tx, p: { id: string; reason: string; actorId: string }) {
  const j = await tx.journalEntry.findUniqueOrThrow({ where: { id: p.id }, include: { lines: true } });
  if (j.source !== "MANUAL") throw new Error("Chỉ đảo được bút toán nhập tay — bút toán nghiệp vụ huỷ ở màn gốc (Sổ quỹ, Công nợ…)");
  if (j.reversalOf) throw new Error("Đây là bút toán đảo");
  if (await tx.journalEntry.findFirst({ where: { reversalOf: j.id } })) throw new Error("Bút toán đã được đảo");
  const lines = reverseLines(j.lines.map((l) => ({ accountCode: l.accountCode, debitVnd: l.debitVnd, creditVnd: l.creditVnd, shopId: l.shopId, entityId: l.entityId })));
  const r = await createJournal(tx, {
    data: { date: await postingDateFor(tx, j.date), memo: `Đảo: ${j.memo}${p.reason.trim() ? ` — ${p.reason.trim()}` : ""}`, source: "MANUAL", reversalOf: j.id, createdBy: p.actorId, lines: { create: lines } },
  });
  await audit(tx, { actorId: p.actorId, tableName: "JournalEntry", recordId: j.id, action: "VOID", after: r });
  return r;
}

export const SOURCE_VI: Record<string, string> = {
  CASH_TXN: "Sổ quỹ",
  OPENING: "Số dư đầu kỳ",
  EXPENSE: "Chi phí",
  BILL: "Hoá đơn NCC",
  BILL_PAYMENT: "Trả NCC",
  PAYROLL: "Kỳ lương",
  PAYROLL_PAYMENT: "Chi lương",
  EXPENSE_PAYMENT: "Chi đề nghị",
  ADJUST: "Chênh lệch",
  ALLOCATION: "Phân bổ",
  CLOSING: "Kết chuyển",
  MANUAL: "Nhập tay",
  AR: "Phải thu",
  AR_RECEIPT: "Thu nợ",
  TAX_PAYMENT: "Nộp thuế",
};
