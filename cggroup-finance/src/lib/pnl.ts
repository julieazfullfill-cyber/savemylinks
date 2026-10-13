// Màn hình 7 — P&L quản trị từ sổ cái. Không có ô nào để gõ tay: mọi số là tổng các dòng bút toán.
import type { AccountType } from "@prisma/client";

export type LedgerRow = { month: string; accountCode: string; accountName: string; type: AccountType; debit: bigint; credit: bigint };

export type PnlMonth = {
  revenue: bigint;
  cogs: bigint;
  gross: bigint;
  expense: bigint;
  other: bigint;
  net: bigint;
};

const ZERO: PnlMonth = { revenue: 0n, cogs: 0n, gross: 0n, expense: 0n, other: 0n, net: 0n };

/**
 * Doanh thu và thu khác tính theo số dư Có (có − nợ); giá vốn, chi phí theo số dư Nợ (nợ − có).
 * Tài khoản OTHER: 701 chênh lệch tỷ giá, 702 thu chi bất thường — dương là thu, âm là chi.
 * Lợi nhuận = doanh thu − giá vốn − chi phí + khác.
 */
export function buildPnl(rows: LedgerRow[]) {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const byMonth = new Map<string, PnlMonth>(months.map((m) => [m, { ...ZERO }]));
  const byAccount = new Map<string, { code: string; name: string; type: AccountType; months: Map<string, bigint> }>();

  for (const r of rows) {
    const m = byMonth.get(r.month)!;
    const creditNature = r.type === "REVENUE" || r.type === "OTHER";
    const v = creditNature ? r.credit - r.debit : r.debit - r.credit;
    if (r.type === "REVENUE") m.revenue += v;
    else if (r.type === "COGS") m.cogs += v;
    else if (r.type === "EXPENSE") m.expense += v;
    else if (r.type === "OTHER") m.other += v;
    else continue;
    const acc = byAccount.get(r.accountCode) ?? { code: r.accountCode, name: r.accountName, type: r.type, months: new Map() };
    acc.months.set(r.month, (acc.months.get(r.month) ?? 0n) + v);
    byAccount.set(r.accountCode, acc);
  }
  for (const m of byMonth.values()) {
    m.gross = m.revenue - m.cogs;
    m.net = m.gross - m.expense + m.other;
  }
  const total = [...byMonth.values()].reduce(
    (a, m) => ({
      revenue: a.revenue + m.revenue,
      cogs: a.cogs + m.cogs,
      gross: a.gross + m.gross,
      expense: a.expense + m.expense,
      other: a.other + m.other,
      net: a.net + m.net,
    }),
    { ...ZERO },
  );
  const accounts = [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code));
  return { months, byMonth, accounts, total };
}

export type LegacyRow = { team: string; year: number; month: number; revenueUsd: string; expenseUsd: string; profitUsd: string; warning: string | null };

/**
 * CSV số liệu Excel T4–T10: team,year,month,revenueUsd,expenseUsd,profitUsd (dòng tiêu đề tuỳ chọn).
 * Số dùng dấu chấm thập phân, không phân cách nghìn. Không chặn khi profit ≠ revenue − expense —
 * file cũ có lỗi thật — nhưng gắn cảnh báo để thấy khi đối chiếu.
 */
export function parseLegacyCsv(text: string): LegacyRow[] {
  const out: LegacyRow[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    const cells = line.split(/[,;\t]/).map((c) => c.trim());
    if (i === 0 && /team/i.test(cells[0])) return;
    if (cells.length < 6) throw new Error(`Dòng ${i + 1}: cần 6 cột team,year,month,revenueUsd,expenseUsd,profitUsd`);
    const [team, y, m, rev, exp, prof] = cells;
    const year = Number(y);
    const month = Number(m);
    if (!team) throw new Error(`Dòng ${i + 1}: thiếu team`);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error(`Dòng ${i + 1}: năm không hợp lệ`);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error(`Dòng ${i + 1}: tháng không hợp lệ`);
    for (const v of [rev, exp, prof]) if (!/^-?\d+(\.\d{1,2})?$/.test(v)) throw new Error(`Dòng ${i + 1}: số "${v}" không hợp lệ (dùng dấu chấm, tối đa 2 số lẻ)`);
    const cents = (s: string) => Math.round(Number(s) * 100);
    const warning = cents(rev) - cents(exp) !== cents(prof) ? `profit ${prof} ≠ revenue − expense (${((cents(rev) - cents(exp)) / 100).toFixed(2)})` : null;
    out.push({ team, year, month, revenueUsd: rev, expenseUsd: exp, profitUsd: prof, warning });
  });
  if (!out.length) throw new Error("Không có dòng dữ liệu nào");
  return out;
}
