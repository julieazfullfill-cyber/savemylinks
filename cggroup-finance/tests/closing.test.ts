import { describe, expect, it } from "vitest";
import { parseClosingForm } from "@/lib/closing";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const accs = [
  { id: "a", code: "AWHK", currency: "USD" as const },
  { id: "b", code: "BANKVN", currency: "VND" as const },
];

describe("parseClosingForm", () => {
  it("chỉ chốt tài khoản có nhập số khả dụng; đổi theo tiền tài khoản", () => {
    const r = parseClosingForm(fd({ date: "2026-10-31", avail_a: "1.250,50", res_a: "300", rel_a: "2026-11-14" }), accs);
    expect(r.rows).toEqual([{ accountId: "a", available: 125_050n, reserved: 30_000n, releaseOn: new Date("2026-11-14T00:00:00Z"), note: null }]);
  });
  it("tiền bị giam cần ngày về, và ngày về sau ngày chốt", () => {
    expect(() => parseClosingForm(fd({ date: "2026-10-31", avail_a: "1", res_a: "5" }), accs)).toThrow(/ngày dự kiến về/);
    expect(() => parseClosingForm(fd({ date: "2026-10-31", avail_a: "1", res_a: "5", rel_a: "2026-10-01" }), accs)).toThrow(/sau ngày chốt/);
  });
  it("không nhập gì → lỗi", () => {
    expect(() => parseClosingForm(fd({ date: "2026-10-31" }), accs)).toThrow(/Chưa nhập/);
  });
});
