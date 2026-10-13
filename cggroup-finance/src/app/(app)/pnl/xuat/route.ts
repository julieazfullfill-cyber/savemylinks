// Màn 25 — xuất P&L ra file Excel (CSV UTF-8): cả năm theo tháng × tài khoản, hoặc một tháng theo chiều.
import { requireUser } from "@/lib/auth";
import { dayOfMonth } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { buildPnl } from "@/lib/pnl";
import { loadLedgerRows } from "@/lib/pnl-data";
import { DIM_VI, pnlByDimension, toCsv, type Dim } from "@/lib/pnl-dims";

export async function GET(req: Request) {
  await requireUser(["ADMIN", "QUAN_LY", "KE_TOAN"]);
  const q = new URL(req.url).searchParams;
  const chieu = q.get("chieu") as Dim | null;
  const thang = q.get("thang") ?? "";
  let name: string;
  let rows: (string | number | bigint)[][];

  if (chieu && chieu in DIM_VI && /^\d{4}-\d{2}$/.test(thang)) {
    const [y, m] = thang.split("-").map(Number);
    const r = await pnlByDimension(prisma, { year: y, month: m, dim: chieu });
    const cols = r.columns;
    rows = [
      [`P&L ${m}/${y} theo ${DIM_VI[chieu]}`, ...cols.map((c) => c.label), "Tổng"],
      ["Doanh thu", ...cols.map((c) => c.pnl.revenueVnd), r.total.revenueVnd],
      ["Giá vốn", ...cols.map((c) => c.pnl.cogsVnd), r.total.cogsVnd],
      ["Lãi gộp", ...cols.map((c) => c.pnl.grossProfitVnd), r.total.grossProfitVnd],
      ["Chi phí hoạt động", ...cols.map((c) => c.pnl.expenseVnd), r.total.expenseVnd],
      ["Thu chi khác", ...cols.map((c) => c.pnl.otherVnd), r.total.otherVnd],
      ["Lợi nhuận", ...cols.map((c) => c.pnl.netProfitVnd), r.total.netProfitVnd],
      [`Lợi nhuận ${r.prev.month}/${r.prev.year}`, ...cols.map((c) => c.prevNet), r.prevTotal.netProfitVnd],
    ];
    name = `pnl-${thang}-${chieu}.csv`;
  } else {
    const year = Number(q.get("nam")) || new Date().getUTCFullYear();
    const pnl = buildPnl(await loadLedgerRows(prisma, dayOfMonth(year, 0, 1), dayOfMonth(year, 11, 31)));
    const months = pnl.months;
    rows = [["TK", "Khoản mục (VND)", ...months, "Cả năm"]];
    const KEYS = [["revenue", "Doanh thu", "REVENUE"], ["cogs", "Giá vốn", "COGS"], ["gross", "Lãi gộp", null], ["expense", "Chi phí hoạt động", "EXPENSE"], ["other", "Thu chi khác", "OTHER"], ["net", "Lợi nhuận", null]] as const;
    for (const [key, label, type] of KEYS) {
      rows.push(["", label, ...months.map((m) => pnl.byMonth.get(m)![key]), pnl.total[key]]);
      for (const a of pnl.accounts.filter((x) => x.type === type)) {
        rows.push([a.code, `  ${a.name}`, ...months.map((m) => a.months.get(m) ?? 0n), [...a.months.values()].reduce((s, v) => s + v, 0n)]);
      }
    }
    name = `pnl-${year}.csv`;
  }
  return new Response(toCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
  });
}
