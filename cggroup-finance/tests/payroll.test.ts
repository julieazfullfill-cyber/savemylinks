import { describe, expect, it } from "vitest";
import { allocateOverhead, bonusGate, computeBonus, computeKpi, HELD_REASON_LOSS, type BonusTier } from "@/lib/kpi";
import { computePayrollLine, countWorkedDays, prorate, totalPayroll } from "@/lib/payroll";
import { buildPayrollJournal } from "@/lib/payroll-journal";
import { calcPit, PIT_DEFAULT, taxableIncome } from "@/lib/pit";
import { AUG_COMPANY_PROFIT_VND, AUG_STAFF, AUG_STANDARD_DAYS } from "../scripts/aug2026-fixture";

const contract = (base: bigint, allow = 0n) => ({
  baseSalaryVnd: base,
  allowanceVnd: allow,
  mealVnd: 0n,
  transportVnd: 0n,
  dutyVnd: 0n,
  insuranceSalaryVnd: base,
  dependents: 0,
});

describe("thuế TNCN", () => {
  it("luỹ tiến từng phần", () => {
    expect(calcPit(0n)).toBe(0n);
    expect(calcPit(5_000_000n)).toBe(250_000n);
    expect(calcPit(6_900_000n)).toBe(440_000n); // 250k + 1,9tr × 10%
    expect(calcPit(100_000_000n)).toBe(250_000n + 500_000n + 1_200_000n + 2_800_000n + 5_000_000n + 8_400_000n + 7_000_000n);
  });
  it("giảm trừ gia cảnh + người phụ thuộc", () => {
    expect(taxableIncome(20_000_000n, 2_100_000n, 0n, 0, PIT_DEFAULT)).toBe(6_900_000n);
    expect(taxableIncome(20_000_000n, 2_100_000n, 0n, 2, PIT_DEFAULT)).toBe(0n);
  });
});

describe("chấm công & chia lương", () => {
  it("ONL tính đủ một ngày công", () => expect(countWorkedDays([1, "ONL", 0.5, 0, "ONL"])).toBe(3.5));
  it("prorate làm tròn về đồng, không vượt lương cứng", () => {
    expect(prorate(11_000_000n, 22, 24)).toBe(10_083_333n);
    expect(prorate(9_000_000n, 20.5, 24)).toBe(7_687_500n);
    expect(prorate(9_000_000n, 30, 24)).toBe(9_000_000n);
    expect(prorate(9_000_000n, 1, 0)).toBe(0n);
  });
  it("phụ cấp ăn miễn thuế đến trần, phần vượt chịu thuế", () => {
    const base = { ...contract(20_000_000n), mealVnd: 1_000_000n };
    const l = computePayrollLine({
      employeeId: "x", contract: base, workedDays: 24, standardDays: 24,
      salesBonusVnd: 0n, perfPayVnd: 0n, penaltyVnd: 0n,
    });
    // chịu thuế = 21tr − 2,1tr − 730k − 11tr = 7.170.000 → 250k + 217k
    expect(l.pitVnd).toBe(467_000n);
  });
});

describe("self-test tháng 8/2026 (đặc tả mục 09)", () => {
  const gated = AUG_STAFF.map((s) => ({ ...s, gate: bonusGate(s.bonus, AUG_COMPANY_PROFIT_VND) }));
  const lines = gated.map((s) =>
    computePayrollLine({
      employeeId: s.id, contract: contract(s.base, s.allow), workedDays: s.worked, standardDays: AUG_STANDARD_DAYS,
      salesBonusVnd: s.gate.payableVnd, bonusHeldVnd: s.gate.heldVnd, perfPayVnd: 0n, penaltyVnd: 0n,
    }),
  );

  it("cổng chặn giữ lại toàn bộ 55.595.152đ thưởng trong tháng lỗ", () => {
    expect(gated.reduce((a, s) => a + s.gate.heldVnd, 0n)).toBe(55_595_152n);
    expect(gated.every((s) => s.gate.payableVnd === 0n)).toBe(true);
    expect(gated[3].gate.reason).toBe(HELD_REASON_LOSS);
  });

  it("từng dòng khớp bảng kết quả trong đặc tả", () => {
    expect(lines.map((l) => [l.proratedVnd, l.insuranceEmpVnd, l.pitVnd, l.netVnd])).toEqual([
      [20_000_000n, 2_100_000n, 440_000n, 17_460_000n],
      [11_500_000n, 1_207_500n, 19_625n, 11_372_875n],
      [7_687_500n, 945_000n, 0n, 7_842_500n],
      [10_083_333n, 1_155_000n, 0n, 10_028_333n],
      [10_000_000n, 1_050_000n, 0n, 10_050_000n],
    ]);
  });

  it("tổng kỳ = cộng các dòng", () => {
    const t = totalPayroll(lines);
    expect(t).toMatchObject({
      headcount: 5,
      netVnd: 56_753_708n,
      insuranceEmpVnd: 6_457_500n,
      insuranceCoVnd: 13_222_500n,
      pitVnd: 459_625n,
      companyCostVnd: 76_893_333n,
      bonusHeldVnd: 55_595_152n,
    });
  });

  it("bút toán cân và đúng tài khoản", () => {
    expect(buildPayrollJournal(lines).map((l) => [l.accountCode, l.debitVnd, l.creditVnd])).toEqual([
      ["601", 63_670_833n, 0n],
      ["602", 13_222_500n, 0n],
      ["202", 0n, 56_753_708n],
      ["203", 0n, 19_680_000n],
      ["204", 0n, 459_625n],
    ]);
  });

  it("có khoản phạt thì bút toán vẫn cân (Có 702)", () => {
    const withPenalty = computePayrollLine({
      employeeId: "p", contract: contract(10_000_000n), workedDays: 24, standardDays: 24,
      salesBonusVnd: 0n, perfPayVnd: 0n, penaltyVnd: 200_000n,
    });
    const j = buildPayrollJournal([withPenalty]);
    expect(j.find((l) => l.accountCode === "702")?.creditVnd).toBe(200_000n);
  });
});

describe("KPI & thưởng", () => {
  const tiers: BonusTier[] = [
    { fromPct: 80, toPct: 100, ratePct: 0 },
    { fromPct: 100, toPct: 120, ratePct: 2 },
    { fromPct: 120, toPct: 150, ratePct: 3 },
    { fromPct: 150, toPct: null, ratePct: 4, capVnd: 5_000_000 },
  ];

  it("profit trừ cả chi phí chung phân bổ", () => {
    const k = computeKpi({ cashReceivedUsd: 10_000, ffCostUsd: 4_000, overheadUsd: 1_500, targetUsd: 4_000 });
    expect(k).toEqual({ profitUsd: 4_500, targetUsd: 4_000, achievedPct: 1.125, overUsd: 500 });
  });

  it("thưởng theo bậc trên phần vượt, có trần", () => {
    const k = computeKpi({ cashReceivedUsd: 10_000, ffCostUsd: 4_000, overheadUsd: 1_500, targetUsd: 4_000 });
    expect(computeBonus(k, tiers, "26060")).toBe(260_600n); // 500 × 26.060 × 2%
    const big = computeKpi({ cashReceivedUsd: 100_000, ffCostUsd: 0, overheadUsd: 0, targetUsd: 10_000 });
    expect(computeBonus(big, tiers, 26060)).toBe(5_000_000n);
    const miss = computeKpi({ cashReceivedUsd: 3_000, ffCostUsd: 0, overheadUsd: 0, targetUsd: 4_000 });
    expect(computeBonus(miss, tiers, 26060)).toBe(0n);
  });

  it("phân bổ chi phí chung theo tỷ trọng", () => {
    expect(allocateOverhead(2_500, 10_000, 8_000)).toBe(2_000);
    expect(allocateOverhead(1, 0, 8_000)).toBe(0);
  });

  it("cổng chặn: lãi thì chi, chưa biết lợi nhuận thì giữ, vượt cấp thì chi", () => {
    expect(bonusGate(100n, 1n).payableVnd).toBe(100n);
    expect(bonusGate(100n, null).heldVnd).toBe(100n);
    expect(bonusGate(100n, -1n, true).payableVnd).toBe(100n);
  });
});
