// Màn 26 — chạy phân bổ chi phí chung trên sổ cái thật.
// Rổ = số dư Nợ trong tháng của từng TK nguồn trên các dòng CHƯA gắn shop. Bút toán phân bổ:
//   Có TK nguồn (không shop) = rổ;  Nợ cùng TK nguồn gắn shop = phần của shop.
// Tổng P&L công ty không đổi; P&L theo shop (màn 7) nhận đủ chi phí chung.
import { allocationTable, type AllocationLine, type Basis, type Target } from "./allocation";
import { audit } from "./audit";
import type { Tx } from "./db";
import { createJournal, postingDateFor } from "./journal";
import { assertBalanced, reverseLines, type LineDraft } from "./ledger";
import { monthRange } from "./gl-data";

export type AllocationPreview = {
  pools: { accountCode: string; accountName: string; poolVnd: bigint; lines: AllocationLine[]; exact: boolean }[];
  poolVnd: bigint;
  targets: (Target & { code: string })[];
  byShop: { targetId: string; name: string; amountVnd: bigint; sharePct: number }[];
};

/** Shop đích + trọng số: doanh thu tháng (TK 4xx gắn shop), số người của team phụ trách, hoặc chia đều. */
export async function loadTargets(tx: Tx, year: number, month: number): Promise<(Target & { code: string })[]> {
  const { from, to } = monthRange(year, month);
  const [shops, revenue, employees] = await Promise.all([
    tx.shop.findMany({ where: { status: { not: "CLOSED" } }, orderBy: { code: "asc" } }),
    tx.journalLine.groupBy({
      by: ["shopId"],
      where: { shopId: { not: null }, account: { type: "REVENUE" }, entry: { date: { gte: from, lte: to }, source: { not: "CLOSING" } } },
      _sum: { debitVnd: true, creditVnd: true },
    }),
    tx.employee.findMany({
      where: { joinedAt: { lte: to }, OR: [{ leftAt: null }, { leftAt: { gte: from } }] },
      select: { userId: true, departmentId: true },
    }),
  ]);
  const rev = new Map(revenue.map((r) => [r.shopId!, (r._sum.creditVnd ?? 0n) - (r._sum.debitVnd ?? 0n)]));
  // Giá vốn fulfillment theo shop: đơn fulfill gửi NCC trong tháng (cent USD — chỉ cần tỷ trọng, không cần quy VND)
  const ffs = await tx.fulfillmentOrder.findMany({
    where: { submittedAt: { gte: from, lte: to }, order: { status: { not: "CANCELLED" } } },
    select: { costUsd: true, shipUsd: true, order: { select: { shopId: true } } },
  });
  const ff = new Map<string, bigint>();
  for (const f of ffs) ff.set(f.order.shopId, (ff.get(f.order.shopId) ?? 0n) + BigInt(Math.round((Number(f.costUsd) + Number(f.shipUsd)) * 100)));
  const deptOfUser = new Map(employees.filter((e) => e.userId).map((e) => [e.userId!, e.departmentId]));
  const deptSize = new Map<string, number>();
  for (const e of employees) if (e.departmentId) deptSize.set(e.departmentId, (deptSize.get(e.departmentId) ?? 0) + 1);
  const shopDept = new Map(shops.map((s) => [s.id, s.ownerId ? deptOfUser.get(s.ownerId) ?? null : null]));
  const shopsPerDept = new Map<string, number>();
  for (const d of shopDept.values()) if (d) shopsPerDept.set(d, (shopsPerDept.get(d) ?? 0) + 1);

  return shops.map((s) => {
    const d = shopDept.get(s.id);
    return {
      id: s.id,
      code: s.code,
      name: `${s.code} · ${s.name}`,
      revenueVnd: rev.get(s.id) ?? 0n,
      ffVnd: ff.get(s.id) ?? 0n,
      // số người của team chia đều cho các shop của team
      headcount: d ? (deptSize.get(d) ?? 0) / (shopsPerDept.get(d) ?? 1) : 0,
    };
  });
}

export async function previewAllocation(tx: Tx, p: { ruleId: string; year: number; month: number }): Promise<AllocationPreview> {
  const rule = await tx.allocationRule.findUniqueOrThrow({ where: { id: p.ruleId } });
  const { from, to } = monthRange(p.year, p.month);
  const [sums, accounts, targets] = await Promise.all([
    tx.journalLine.groupBy({
      by: ["accountCode"],
      where: { accountCode: { in: rule.sourceAccounts }, shopId: null, entry: { date: { gte: from, lte: to }, source: { not: "CLOSING" } } },
      _sum: { debitVnd: true, creditVnd: true },
    }),
    tx.account.findMany({ where: { code: { in: rule.sourceAccounts } } }),
    loadTargets(tx, p.year, p.month),
  ]);
  const name = new Map(accounts.map((a) => [a.code, a.name]));
  const pools = sums
    .map((s) => ({ accountCode: s.accountCode, accountName: name.get(s.accountCode) ?? "", poolVnd: (s._sum.debitVnd ?? 0n) - (s._sum.creditVnd ?? 0n) }))
    .filter((s) => s.poolVnd > 0n)
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode))
    .map((s) => ({ ...s, ...allocationTable(s.poolVnd, targets, rule.basis as Basis) }));

  const byShop = new Map<string, { targetId: string; name: string; amountVnd: bigint; sharePct: number }>();
  for (const pool of pools) {
    for (const l of pool.lines) {
      const v = byShop.get(l.targetId) ?? { targetId: l.targetId, name: l.targetName, amountVnd: 0n, sharePct: l.sharePct };
      v.amountVnd += l.amountVnd;
      byShop.set(l.targetId, v);
    }
  }
  return {
    pools,
    poolVnd: pools.reduce((a, x) => a + x.poolVnd, 0n),
    targets,
    byShop: [...byShop.values()].sort((a, b) => Number(b.amountVnd - a.amountVnd)),
  };
}

export async function runAllocation(tx: Tx, p: { ruleId: string; year: number; month: number; actorId: string }) {
  const rule = await tx.allocationRule.findUniqueOrThrow({ where: { id: p.ruleId } });
  if (!rule.active) throw new Error("Quy tắc đã ngưng dùng");
  const existing = await tx.allocationRun.findUnique({ where: { ruleId_year_month: { ruleId: p.ruleId, year: p.year, month: p.month } } });
  if (existing) throw new Error(`Quy tắc "${rule.name}" đã chạy cho ${p.month}/${p.year} — huỷ lần chạy cũ trước khi chạy lại`);
  const pv = await previewAllocation(tx, p);
  if (pv.poolVnd <= 0n) throw new Error("Rổ chi phí tháng này bằng 0 — chưa có chi phí chưa gắn shop trên các TK nguồn");
  if (!pv.byShop.length) throw new Error("Không có shop nào có trọng số > 0 để nhận phân bổ (chưa có doanh thu / chưa gán người phụ trách)");

  const lines: LineDraft[] = [];
  for (const pool of pv.pools) {
    if (!pool.exact) throw new Error(`Phân bổ TK ${pool.accountCode} không khớp rổ`);
    lines.push({ accountCode: pool.accountCode, debitVnd: 0n, creditVnd: pool.poolVnd, shopId: null });
    for (const l of pool.lines) if (l.amountVnd > 0n) lines.push({ accountCode: pool.accountCode, debitVnd: l.amountVnd, creditVnd: 0n, shopId: l.targetId });
  }
  assertBalanced(lines);
  const { to } = monthRange(p.year, p.month);
  const journal = await createJournal(tx, {
    data: { date: to, memo: `Phân bổ chi phí chung ${p.month}/${p.year}: ${rule.name}`, source: "ALLOCATION", createdBy: p.actorId, lines: { create: lines } },
  });
  const run = await tx.allocationRun.create({
    data: { ruleId: rule.id, year: p.year, month: p.month, poolVnd: pv.poolVnd, journalId: journal.id, createdBy: p.actorId },
  });
  await audit(tx, { actorId: p.actorId, tableName: "AllocationRun", recordId: run.id, action: "CREATE", after: run });
  return { run, preview: pv };
}

/** Huỷ một lần chạy: bút toán đảo (kỳ đã đóng thì ghi hôm nay), xoá dòng AllocationRun để chạy lại được. */
export async function undoAllocation(tx: Tx, p: { runId: string; actorId: string }) {
  const run = await tx.allocationRun.findUniqueOrThrow({ where: { id: p.runId } });
  if (run.journalId) {
    const j = await tx.journalEntry.findUniqueOrThrow({ where: { id: run.journalId }, include: { lines: true } });
    const lines = reverseLines(j.lines.map((l) => ({ accountCode: l.accountCode, debitVnd: l.debitVnd, creditVnd: l.creditVnd, shopId: l.shopId, entityId: l.entityId })));
    await createJournal(tx, {
      data: { date: await postingDateFor(tx, j.date), memo: `Huỷ: ${j.memo}`, source: "ALLOCATION", reversalOf: j.id, createdBy: p.actorId, lines: { create: lines } },
    });
  }
  await tx.allocationRun.delete({ where: { id: run.id } });
  await audit(tx, { actorId: p.actorId, tableName: "AllocationRun", recordId: run.id, action: "VOID", before: run });
}

export async function saveRule(
  tx: Tx,
  p: { id?: string; name: string; sourceAccounts: string[]; basis: Basis; active: boolean; actorId: string },
) {
  if (!p.name.trim()) throw new Error("Thiếu tên quy tắc");
  if (!p.sourceAccounts.length) throw new Error("Chọn ít nhất một tài khoản chi phí");
  const accounts = await tx.account.findMany({ where: { code: { in: p.sourceAccounts } } });
  const bad = accounts.filter((a) => a.type !== "EXPENSE" && a.type !== "COGS");
  if (accounts.length !== p.sourceAccounts.length || bad.length) throw new Error("Chỉ phân bổ được TK chi phí / giá vốn");
  const data = { name: p.name.trim(), sourceAccounts: p.sourceAccounts, basis: p.basis, active: p.active };
  const rule = p.id ? await tx.allocationRule.update({ where: { id: p.id }, data }) : await tx.allocationRule.create({ data });
  await audit(tx, { actorId: p.actorId, tableName: "AllocationRule", recordId: rule.id, action: p.id ? "UPDATE" : "CREATE", after: rule });
  return rule;
}
