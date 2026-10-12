import { describe, expect, it } from "vitest";
import { parseContractForm, parseEmployeeForm } from "@/lib/hr-forms";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const emp = { code: "nv01", fullName: "Dương Thành Công", status: "OFFICIAL", workMode: "ONLINE", joinedAt: "2025-01-01" };

describe("parseEmployeeForm", () => {
  it("mã viết hoa, trường trống thành null", () => {
    expect(parseEmployeeForm(fd(emp))).toMatchObject({ code: "NV01", workMode: "ONLINE", leftAt: null, departmentId: null });
  });
  it("trạng thái và ngày nghỉ phải khớp nhau", () => {
    expect(() => parseEmployeeForm(fd({ ...emp, status: "RESIGNED" }))).toThrow(/ngày nghỉ việc/);
    expect(() => parseEmployeeForm(fd({ ...emp, leftAt: "2026-01-01" }))).toThrow(/Đã nghỉ/);
    expect(() => parseEmployeeForm(fd({ ...emp, status: "RESIGNED", leftAt: "2024-01-01" }))).toThrow(/sau ngày vào làm/);
  });
});

describe("parseContractForm", () => {
  it("tiền VND nhập kiểu thường → BigInt", () => {
    const c = parseContractForm(fd({ effectiveFrom: "2026-12-01", baseSalaryVnd: "11.500.000", allowanceVnd: "1,100,000", dependents: "1" }));
    expect(c).toMatchObject({ baseSalaryVnd: 11_500_000n, allowanceVnd: 1_100_000n, mealVnd: 0n, dependents: 1 });
  });
  it("chặn lương cứng thiếu/0 — lỗi gõ 39.250 kiểu tháng 8 vẫn phải qua người duyệt", () => {
    expect(() => parseContractForm(fd({ effectiveFrom: "2026-12-01" }))).toThrow(/Thiếu lương cứng/);
    expect(() => parseContractForm(fd({ effectiveFrom: "2026-12-01", baseSalaryVnd: "0" }))).toThrow(/lớn hơn 0/);
  });
});
