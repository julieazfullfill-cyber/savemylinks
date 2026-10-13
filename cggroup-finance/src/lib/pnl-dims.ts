// Màn 7/25 — P&L một tháng theo chiều shop / pháp nhân / team, so với kỳ trước. Đọc thẳng sổ cái.
// Team = phòng ban của người phụ trách shop (Shop.ownerId → Employee.userId → Department).
import type { Tx } from "./db";
import { profitAndLoss, type Pnl } from "./gl";
import { loadGlLines, monthRange, prevMonth, type DimRow } from "./gl-data";

export type Dim = "shop" | "entity" | "team";
export const DIM_VI: Record<Dim, string> = { shop: "Shop", entity: "Pháp nhân", team: "Team" };
export const UNASSIGNED = "__none";

export type DimColumn = { key: string; label: string; pnl: Pnl; prevNet: bigint };

async function labels(tx: Tx, dim: Dim) {
  if (dim === "entity") {
    const es = await tx.legalEntity.findMany({ select: { id: true, code: true } });
    return { label: new Map(es.map((e) => [e.id, e.code])), regroup: (id: string | null) => id };
  }
  const shops = await tx.shop.findMany({ select: { id: true, code: true, ownerId: true } });
  if (dim === "shop") return { label: new Map(shops.map((s) => [s.id, s.code])), regroup: (id: string | null) => id };
  const [emps, depts] = await Promise.all([
    tx.employee.findMany({ where: { userId: { not: null } }, select: { userId: true, departmentId: true } }),
    tx.department.findMany({ select: { id: true, name: true } }),
  ]);
  const deptOfUser = new Map(emps.map((e) => [e.userId!, e.departmentId]));
  const deptOfShop = new Map(shops.map((s) => [s.id, s.ownerId ? deptOfUser.get(s.ownerId) ?? null : null]));
  return { label: new Map(depts.map((d) => [d.id, d.name])), regroup: (id: string | null) => (id ? deptOfShop.get(id) ?? null : null) };
}

const groupBy = (rows: DimRow[], regroup: (id: string | null) => string | null) => {
  const m = new Map<string, DimRow[]>();
  for (const r of rows) {
    const k = regroup(r.dim) ?? UNASSIGNED;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
};

export async function pnlByDimension(tx: Tx, p: { year: number; month: number; dim: Dim }) {
  const by = p.dim === "entity" ? "entity" : "shop";
  const cur = monthRange(p.year, p.month);
  const pm = prevMonth(p.year, p.month);
  const prev = monthRange(pm.year, pm.month);
  const types = ["REVENUE", "COGS", "EXPENSE", "OTHER"] as const;
  const [rows, prevRows, l] = await Promise.all([
    loadGlLines(tx, { ...cur, excludeClosing: true, by, types: [...types] }),
    loadGlLines(tx, { ...prev, excludeClosing: true, by, types: [...types] }),
    labels(tx, p.dim),
  ]);
  const g = groupBy(rows, l.regroup);
  const gp = groupBy(prevRows, l.regroup);
  const keys = [...new Set([...g.keys(), ...gp.keys()])];
  const columns: DimColumn[] = keys
    .map((k) => ({
      key: k,
      label: k === UNASSIGNED ? "Chưa gắn" : l.label.get(k) ?? k,
      pnl: profitAndLoss(g.get(k) ?? []),
      prevNet: profitAndLoss(gp.get(k) ?? []).netProfitVnd,
    }))
    .sort((a, b) => (a.key === UNASSIGNED ? 1 : b.key === UNASSIGNED ? -1 : Number(b.pnl.revenueVnd - a.pnl.revenueVnd)));
  return { columns, total: profitAndLoss(rows), prevTotal: profitAndLoss(prevRows), prev: pm };
}

/** CSV mở thẳng bằng Excel: BOM UTF-8, phân cách dấu phẩy, số nguyên không định dạng. */
export function toCsv(rows: (string | number | bigint)[][]): string {
  const cell = (c: string | number | bigint) => {
    const s = String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
