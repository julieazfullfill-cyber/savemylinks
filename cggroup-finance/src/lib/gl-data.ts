// Nạp dòng sổ cái gộp theo tài khoản (và chiều shop / pháp nhân) cho gl.ts — màn 7, 24, 26, 27.
import { Prisma } from "@prisma/client";
import type { Tx } from "./db";
import type { AccountType, LineRow } from "./gl";

export type DimRow = LineRow & { dim: string | null };

/**
 * Tổng nợ/có theo tài khoản trong [from, to] (from bỏ trống = từ đầu).
 * excludeClosing: bỏ bút toán kết chuyển lãi lỗ (source CLOSING) — dùng cho P&L của một kỳ;
 * bảng cân đối thì để nguyên (lãi lỗ đã kết chuyển nằm ở 302).
 */
export async function loadGlLines(
  db: Pick<Tx, "$queryRaw">,
  p: { from?: Date; to: Date; excludeClosing?: boolean; by?: "shop" | "entity"; types?: AccountType[] },
): Promise<DimRow[]> {
  const dim = p.by === "shop" ? Prisma.sql`l."shopId"` : p.by === "entity" ? Prisma.sql`l."entityId"` : Prisma.sql`NULL::text`;
  const conds = [Prisma.sql`e."date" <= ${p.to}`];
  if (p.from) conds.push(Prisma.sql`e."date" >= ${p.from}`);
  if (p.excludeClosing) conds.push(Prisma.sql`e.source <> 'CLOSING'`);
  if (p.types?.length) conds.push(Prisma.sql`a."type"::text IN (${Prisma.join(p.types)})`);
  const rows = await db.$queryRaw<{ code: string; name: string; type: AccountType; dim: string | null; debit: bigint; credit: bigint }[]>(Prisma.sql`
    SELECT l."accountCode" AS code, a."name" AS name, a."type"::text AS type, ${dim} AS dim,
           SUM(l."debitVnd")::bigint AS debit, SUM(l."creditVnd")::bigint AS credit
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "Account" a ON a.code = l."accountCode"
    WHERE ${Prisma.join(conds, " AND ")}
    GROUP BY 1, 2, 3, 4`);
  return rows.map((r) => ({ accountCode: r.code, accountName: r.name, accountType: r.type, debitVnd: r.debit, creditVnd: r.credit, dim: r.dim }));
}

export const monthRange = (year: number, month: number) => ({
  from: new Date(Date.UTC(year, month - 1, 1)),
  to: new Date(Date.UTC(year, month, 0)),
});

export const prevMonth = (year: number, month: number) => (month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 });
