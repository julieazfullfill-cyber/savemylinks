import { describe, expect, it } from "vitest";
import { parseCashTxnForm, parseFxRateForm, txnKind } from "@/lib/cashbook-forms";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const base = { kind: "OUT", accountId: "a1", date: "2026-11-03", amount: "1.250.000", description: "Điện tháng 10", categoryId: "c1" };

describe("parseCashTxnForm", () => {
  it("chi VND", () => {
    expect(parseCashTxnForm(fd(base), "VND")).toMatchObject({ direction: "OUT", amount: 1_250_000n, opening: false, categoryId: "c1", fxRate: null });
  });
  it("thu USD có tỷ giá nhập tay", () => {
    const v = parseCashTxnForm(fd({ ...base, kind: "IN", amount: "125,50", fxRate: "25.400" }), "USD");
    expect(v).toMatchObject({ direction: "IN", amount: 12_550n, fxRate: "25400" });
  });
  it("số dư đầu kỳ: thu vào, bỏ hạng mục và NCC", () => {
    const v = parseCashTxnForm(fd({ ...base, kind: "OPENING", supplierId: "s1" }), "VND");
    expect(v).toMatchObject({ opening: true, direction: "IN", categoryId: null, supplierId: null });
  });
  it("thu từ shop: bắt buộc shop, bỏ hạng mục/NCC", () => {
    const v = parseCashTxnForm(fd({ ...base, kind: "SHOP_IN", shopId: "sh1", supplierId: "s1" }), "USD");
    expect(v).toMatchObject({ shopIncome: true, direction: "IN", shopId: "sh1", categoryId: null, supplierId: null });
    expect(() => parseCashTxnForm(fd({ ...base, kind: "SHOP_IN" }), "USD")).toThrow(/chọn kênh và shop/);
  });
  it("thu khác không gắn shop", () => {
    expect(parseCashTxnForm(fd({ ...base, kind: "IN", shopId: "sh1" }), "VND")).toMatchObject({ shopIncome: false, shopId: null });
  });
  it("txnKind suy loại từ giao dịch đã ghi", () => {
    expect(txnKind({ direction: "IN", shopId: "s", categoryId: null })).toBe("SHOP_IN");
    expect(txnKind({ direction: "IN", shopId: null, categoryId: null })).toBe("IN");
    expect(txnKind({ direction: "IN", shopId: null, categoryId: null, journalSource: "OPENING" })).toBe("OPENING");
    expect(txnKind({ direction: "OUT", shopId: "s", categoryId: "c" })).toBe("OUT");
  });
  it("thiếu diễn giải / số tiền 0", () => {
    expect(() => parseCashTxnForm(fd({ ...base, description: "" }), "VND")).toThrow(/diễn giải/);
    expect(() => parseCashTxnForm(fd({ ...base, amount: "0" }), "VND")).toThrow(/lớn hơn 0/);
  });
});

describe("parseFxRateForm", () => {
  it("chấp nhận kiểu VN và thập phân", () => {
    expect(parseFxRateForm(fd({ date: "2026-11-01", rate: "25.400" })).rate).toBe("25400");
    expect(parseFxRateForm(fd({ date: "2026-11-01", rate: "25400,5" })).rate).toBe("25400.5");
  });
  it("chặn số sai bậc (gõ thiếu/thừa số 0)", () => {
    expect(() => parseFxRateForm(fd({ date: "2026-11-01", rate: "254" }))).toThrow(/1.000–100.000/);
    expect(() => parseFxRateForm(fd({ date: "2026-11-01", rate: "254000" }))).toThrow(/1.000–100.000/);
  });
});
