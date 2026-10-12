import { describe, expect, it } from "vitest";
import { formatMoney, mulFactor, rateToScaled, toMinor, toVnd } from "@/lib/money";

describe("toMinor", () => {
  it("VND: dấu . và , là phân cách nghìn", () => {
    expect(toMinor("1.250.000", "VND")).toBe(1_250_000n);
    expect(toMinor("1,250,000", "VND")).toBe(1_250_000n);
    expect(toMinor(500000, "VND")).toBe(500_000n);
  });
  it("USD: phần thập phân → cent", () => {
    expect(toMinor("12.5", "USD")).toBe(1250n);
    expect(toMinor("12,50", "USD")).toBe(1250n);
    expect(toMinor("1,234.56", "USD")).toBe(123456n);
    expect(toMinor("1.234,56", "USD")).toBe(123456n);
    expect(toMinor("40", "USD")).toBe(4000n);
  });
  it("từ chối rác", () => {
    expect(() => toMinor("abc", "VND")).toThrow();
    expect(() => toMinor("", "USD")).toThrow();
  });
});

describe("toVnd", () => {
  it("cent × tỷ giá, làm tròn half-up về đồng", () => {
    expect(toVnd(1250n, "USD", "25400")).toBe(317_500n);
    expect(toVnd(1n, "USD", "25400.5")).toBe(254n); // 254.005 → 254
    expect(toVnd(3n, "USD", "25416.666667")).toBe(763n); // 762.5 → 763
  });
  it("VND giữ nguyên", () => {
    expect(toVnd(99n, "VND", "1")).toBe(99n);
  });
  it("không mất độ chính xác với số lớn", () => {
    expect(toVnd(10_000_000_000n, "USD", "25400")).toBe(2_540_000_000_000n);
  });
});

describe("helpers", () => {
  it("rateToScaled", () => expect(rateToScaled("25400.123456789")).toBe(25_400_123_456n));
  it("mulFactor", () => expect(mulFactor(1_000_000n, 0.35)).toBe(350_000n));
  it("formatMoney", () => {
    expect(formatMoney(1_250_000n)).toBe("1.250.000 ₫");
    expect(formatMoney(123456n, "USD")).toBe("1.234,56 $");
    expect(formatMoney(-5n, "USD")).toBe("-0,05 $");
  });
});
