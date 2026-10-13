import { describe, expect, it } from "vitest";
import { countLeaveDays, monthDays, parseAttendanceForm } from "@/lib/attendance";
import { parseBizDate as d } from "@/lib/dates";

describe("chấm công", () => {
  it("monthDays", () => {
    expect(monthDays(2026, 2)).toHaveLength(28);
    expect(monthDays(2026, 12)[30]).toEqual(d("2026-12-31"));
  });

  it("đọc lưới: nhận 1/0,5/0, ô trống là xoá, bỏ qua người/ngày ngoài lưới", () => {
    const f = new FormData();
    f.set("a_e1_2026-12-01", "1");
    f.set("a_e1_2026-12-02", "0.5");
    f.set("a_e1_2026-12-03", "");
    f.set("a_x9_2026-12-01", "1");
    f.set("a_e1_2027-01-01", "1");
    const r = parseAttendanceForm(f, ["e1"], monthDays(2026, 12));
    expect(r.upserts.map((u) => [u.employeeId, u.value])).toEqual([["e1", 1], ["e1", 0.5]]);
    expect(r.clears).toHaveLength(1);
    f.set("a_e1_2026-12-04", "2");
    expect(() => parseAttendanceForm(f, ["e1"], monthDays(2026, 12))).toThrow(/không hợp lệ/);
  });

  it("số ngày nghỉ: bỏ chủ nhật và ngày lễ", () => {
    // 21/12 (T2) → 27/12 (CN): 6 ngày làm việc, trừ lễ 25/12
    expect(countLeaveDays(d("2026-12-21"), d("2026-12-27"), new Set(["2026-12-25"]))).toBe(5);
  });
});
