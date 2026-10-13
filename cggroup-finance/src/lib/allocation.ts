// Phân bổ chi phí chung về từng shop — đặc tả GĐ4 mục 04.
// Không có bước này thì biên lãi từng shop là ảo: chi phí văn phòng, VPS, lương bộ phận hỗ trợ
// không được tính vào đâu.

export type Basis = "REVENUE" | "HEADCOUNT" | "EQUAL" | "FF_COST";

export const BASIS_VI: Record<Basis, string> = {
  REVENUE: "Theo tỷ trọng doanh thu",
  HEADCOUNT: "Theo số người của team phụ trách",
  EQUAL: "Chia đều",
  FF_COST: "Theo giá vốn fulfillment của shop (đơn fulfill GĐ3)",
};

export type Target = {
  id: string;
  name: string;
  /** doanh thu kỳ này — dùng khi basis = REVENUE */
  revenueVnd?: bigint;
  /** số người — dùng khi basis = HEADCOUNT */
  headcount?: number;
  /** Bổ sung: giá vốn fulfillment kỳ này (đơn fulfill của shop) — dùng khi basis = FF_COST */
  ffVnd?: bigint;
};

export function computeWeights(targets: Target[], basis: Basis): Map<string, number> {
  const w = new Map<string, number>();
  for (const t of targets) {
    if (basis === "REVENUE") w.set(t.id, Number(t.revenueVnd ?? 0n));
    else if (basis === "HEADCOUNT") w.set(t.id, t.headcount ?? 0);
    else if (basis === "FF_COST") w.set(t.id, Number(t.ffVnd ?? 0n));
    else w.set(t.id, 1);
  }
  return w;
}

/**
 * Chia pool theo trọng số, TỔNG PHÂN BỔ = POOL chính xác từng đồng (phương pháp dư lớn nhất):
 * chia sàn rồi phát phần lẻ cho phần tử có phần dư lớn nhất. Làm tròn từng phần sẽ lệch vài
 * đồng và bút toán phân bổ không cân — trigger journal_balanced chặn ngay.
 */
export function allocate(poolVnd: bigint, weights: Map<string, number>): Map<string, bigint> {
  const entries = [...weights.entries()].filter(([, w]) => w > 0);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  const out = new Map<string, bigint>();
  if (total <= 0 || poolVnd === 0n) return out;

  const pool = Number(poolVnd);
  const parts = entries.map(([k, w]) => {
    const exact = (pool * w) / total;
    const base = Math.floor(exact);
    return { k, base: BigInt(base), rem: exact - base };
  });
  const assigned = parts.reduce((a, p) => a + p.base, 0n);
  let left = poolVnd - assigned;
  parts.sort((a, b) => b.rem - a.rem);
  let i = 0;
  while (left > 0n && parts.length) {
    parts[i % parts.length].base += 1n;
    left -= 1n;
    i++;
  }
  for (const p of parts) out.set(p.k, p.base);
  return out;
}

export type AllocationLine = { targetId: string; targetName: string; amountVnd: bigint; sharePct: number };

export function allocationTable(poolVnd: bigint, targets: Target[], basis: Basis): { lines: AllocationLine[]; totalVnd: bigint; exact: boolean } {
  const weights = computeWeights(targets, basis);
  const alloc = allocate(poolVnd, weights);
  const totalW = [...weights.values()].reduce((a, b) => a + b, 0);
  const lines: AllocationLine[] = targets
    .filter((t) => alloc.has(t.id))
    .map((t) => ({
      targetId: t.id,
      targetName: t.name,
      amountVnd: alloc.get(t.id) ?? 0n,
      sharePct: totalW > 0 ? (weights.get(t.id) ?? 0) / totalW : 0,
    }))
    .sort((a, b) => Number(b.amountVnd - a.amountVnd));
  const totalVnd = lines.reduce((a, l) => a + l.amountVnd, 0n);
  return { lines, totalVnd, exact: totalVnd === poolVnd };
}
