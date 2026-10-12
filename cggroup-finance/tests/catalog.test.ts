import { describe, expect, it } from "vitest";
import { catalogByKey, parseCatalogForm } from "@/lib/catalog";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("parseCatalogForm", () => {
  const sup = catalogByKey("nha-cung-cap")!;
  const cat = catalogByKey("hang-muc-chi-phi")!;
  const usr = catalogByKey("nguoi-dung")!;

  it("NCC công nợ: bỏ chọn trả trước → giữ số ngày, mã viết hoa", () => {
    const v = parseCatalogForm(sup, fd({ code: "merchize", name: "Merchize", service: "FULFILL", creditDays: "30" }), true);
    expect(v).toMatchObject({ code: "MERCHIZE", prepaid: false, creditDays: 30, active: false });
  });

  it("NCC trả trước → creditDays về 0", () => {
    const v = parseCatalogForm(sup, fd({ code: "X", name: "X", prepaid: "on", creditDays: "30", active: "on" }), true);
    expect(v).toMatchObject({ prepaid: true, creditDays: 0, active: true });
  });

  it("sửa: bỏ qua trường immutable", () => {
    const v = parseCatalogForm(sup, fd({ code: "KHAC", name: "Y" }), false);
    expect(v).not.toHaveProperty("code");
  });

  it("ngân sách VND → BigInt, ngày đến hạn kiểm khoảng", () => {
    const v = parseCatalogForm(cat, fd({ code: "LUONG", name: "Lương", accountCode: "601", dueDay: "10", budgetVnd: "300.000.000" }), true);
    expect(v.budgetVnd).toBe(300_000_000n);
    expect(() => parseCatalogForm(cat, fd({ code: "A", name: "A", accountCode: "601", dueDay: "32" }), true)).toThrow(/1–31/);
  });

  it("thiếu trường bắt buộc", () => {
    expect(() => parseCatalogForm(cat, fd({ code: "A", name: "A" }), true)).toThrow(/Thiếu TK kế toán/);
  });

  it("người dùng: mật khẩu trống khi sửa thì giữ nguyên, quá ngắn thì lỗi", () => {
    const v = parseCatalogForm(usr, fd({ email: "A@B.vn", name: "A", role: "KE_TOAN" }), false);
    expect(v).not.toHaveProperty("password");
    expect(v.email).toBe("a@b.vn");
    expect(() => parseCatalogForm(usr, fd({ email: "a@b.vn", name: "A", role: "KE_TOAN", password: "123" }), true)).toThrow(/8 ký tự/);
  });

  it("select ngoài danh sách bị từ chối", () => {
    expect(() => parseCatalogForm(usr, fd({ email: "a@b.vn", name: "A", role: "GOD" }), true)).toThrow(/Vai trò/);
  });
});
