import { Prisma, type AccountType } from "@prisma/client";
import type { Tx } from "./db";
import type { LedgerRow } from "./pnl";

/** Tổng nợ/có theo tháng × tài khoản P&L (doanh thu, giá vốn, chi phí, khác) trong [from, to]. */
export async function loadLedgerRows(db: Pick<Tx, "$queryRaw">, from: Date, to: Date): Promise<LedgerRow[]> {
  return db.$queryRaw<{ month: string; accountCode: string; accountName: string; type: AccountType; debit: bigint; credit: bigint }[]>(Prisma.sql`
    SELECT to_char(e."date", 'YYYY-MM') AS month, l."accountCode", a."name" AS "accountName", a."type"::text AS type,
           SUM(l."debitVnd")::bigint AS debit, SUM(l."creditVnd")::bigint AS credit
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "Account" a ON a.code = l."accountCode"
    WHERE e."date" BETWEEN ${from} AND ${to} AND a."type" IN ('REVENUE', 'COGS', 'EXPENSE', 'OTHER')
    GROUP BY 1, 2, 3, 4`);
}
