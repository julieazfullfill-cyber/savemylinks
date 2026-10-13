import { describe, expect, it } from "vitest";
import { allocate, allocationTable } from "@/lib/allocation";
import { checkMagnitude, checkSupplierBills, runDataChecks } from "@/lib/datachecks";
import { parseBizDate as d } from "@/lib/dates";
import { balanceSheet, profitAndLoss, trialBalance, type LineRow } from "@/lib/gl";
import { buildClosingJournal, canClose, closeChecklist } from "@/lib/period-close";
import { agingBuckets } from "@/lib/receivables";

const L = (accountCode: string, accountType: LineRow["accountType"], debitVnd: bigint, creditVnd: bigint): LineRow => ({
  accountCode,
  accountName: accountCode,
  accountType,
  debitVnd,
  creditVnd,
});

describe("sổ cái (gl.ts)", () => {
  const lines = [L("102", "ASSET", 1_000n, 0n), L("401", "REVENUE", 0n, 1_000n), L("601", "EXPENSE", 300n, 0n), L("102", "ASSET", 0n, 300n), L("702", "OTHER", 50n, 0n), L("101", "ASSET", 0n, 50n)];
  it("cân đối thử, P&L, bảng cân đối", () => {
    expect(trialBalance(lines).balanced).toBe(true);
    const p = profitAndLoss(lines);
    expect(p.netProfitVnd).toBe(650n); // 1000 − 300 − 50 (OTHER ghi nợ = chi)
    const bs = balanceSheet(lines);
    expect(bs.assetsVnd).toBe(650n);
    expect(bs.balanced).toBe(true);
  });
  it("bút toán lệch bị phát hiện", () => {
    expect(trialBalance([...lines, L("102", "ASSET", 7n, 0n)]).diffVnd).toBe(7n);
  });
});

describe("phân bổ (allocation.ts)", () => {
  it("tổng phân bổ = pool chính xác từng đồng, kể cả chia 3 phần bằng nhau", () => {
    const a = allocate(100n, new Map([["a", 1], ["b", 1], ["c", 1]]));
    expect([...a.values()].reduce((x, y) => x + y, 0n)).toBe(100n);
    expect([...a.values()].sort()).toEqual([33n, 33n, 34n]);
  });
  it("trọng số 0 không nhận; pool 0 → rỗng", () => {
    const t = allocationTable(1_000n, [{ id: "a", name: "A", revenueVnd: 0n }, { id: "b", name: "B", revenueVnd: 5n }], "REVENUE");
    expect(t.lines.map((l) => [l.targetId, l.amountVnd])).toEqual([["b", 1_000n]]);
    expect(allocate(0n, new Map([["a", 1]])).size).toBe(0);
  });
});

describe("bộ kiểm tra (datachecks.ts)", () => {
  it("bắt thiếu ba số 0 và thừa ba số 0, bỏ qua biến động thật", () => {
    expect(checkMagnitude("x", 39_250n, [39_000_000n, 41_000_000n])?.code).toBe("MAGNITUDE");
    expect(checkMagnitude("x", 39_000_000_000n, [39_000_000n, 41_000_000n])?.detail).toMatch(/lớn hơn/);
    expect(checkMagnitude("x", 80_000_000n, [39_000_000n, 41_000_000n])).toBeNull();
    expect(checkMagnitude("x", 39_250n, [39_000_000n])).toBeNull(); // chưa đủ lịch sử
  });
  it("hoá đơn NCC: ≤2% bỏ qua, >10% là ERROR", () => {
    expect(checkSupplierBills([{ name: "M", billedVnd: 101n, fulfillmentVnd: 100n }])).toEqual([]);
    expect(checkSupplierBills([{ name: "M", billedVnd: 120n, fulfillmentVnd: 100n }])[0].level).toBe("ERROR");
  });
  it("không có kỳ lương thì bỏ kiểm tra lương", () => {
    const r = runDataChecks({
      payrollTotalVnd: null,
      ledgerSalaryVnd: 5_000_000n,
      cashAccounts: [],
      suppliers: [],
      magnitudeChecks: [],
      totalOrders: 0,
      ordersWithCost: 0,
      netProfitVnd: 1n,
      bonusPaidVnd: 0n,
      trialDiffVnd: 0n,
    });
    expect(r).toEqual([]);
  });
});

describe("đóng sổ (period-close.ts)", () => {
  it("kết chuyển lãi về 302 bên có, số dư âm ghi ngược phía", () => {
    const p = profitAndLoss([L("401", "REVENUE", 0n, 1_000n), L("402", "REVENUE", 100n, 0n), L("601", "EXPENSE", 300n, 0n), L("102", "ASSET", 0n, 200n)]);
    const j = buildClosingJournal(p);
    expect(j).toContainEqual({ accountCode: "402", debitVnd: 0n, creditVnd: 100n });
    expect(j).toContainEqual({ accountCode: "302", debitVnd: 0n, creditVnd: 600n });
    expect(j.reduce((a, l) => a + l.debitVnd - l.creditVnd, 0n)).toBe(0n);
  });
  it("bước không chặn (phân bổ) không cản đóng sổ", () => {
    const steps = closeChecklist({ payoutsReconciled: true, cashStatementsEntered: true, allocationsPosted: false, attendanceApproved: true, payrollClosed: true, checks: [] });
    expect(canClose(steps, [])).toBe(true);
    expect(canClose(steps, [{ code: "X", level: "ERROR", title: "", detail: "" }])).toBe(false);
  });
});

describe("tuổi nợ", () => {
  it("chia theo số ngày quá hạn", () => {
    const b = agingBuckets(
      [
        { dueDate: d("2026-10-20"), outstandingVnd: 1n },
        { dueDate: d("2026-10-01"), outstandingVnd: 2n },
        { dueDate: d("2026-07-01"), outstandingVnd: 4n },
        { dueDate: d("2026-07-01"), outstandingVnd: 0n },
      ],
      d("2026-10-13"),
    );
    expect(b).toEqual([1n, 2n, 0n, 0n, 4n]);
  });
});
