// Số liệu thật tháng 8/2026 — rút gọn từ bảng lương team 1, 5 người đại diện / 23.
// Dùng chung cho scripts/payroll-selftest.ts và tests/payroll.test.ts (đặc tả GĐ2 mục 09).

export const AUG_STANDARD_DAYS = 24;

export const AUG_STAFF = [
  { id: "NV01", name: "Dương Thành Công", base: 20_000_000n, allow: 0n, worked: 24, bonus: 0n },
  { id: "NV03", name: "Luyện Thành Trung", base: 11_500_000n, allow: 1_100_000n, worked: 24, bonus: 1_972_152n },
  { id: "NV08", name: "Nguyễn Đào Diệu My", base: 9_000_000n, allow: 1_100_000n, worked: 20.5, bonus: 0n },
  { id: "NV15", name: "Lê Thị Thảo", base: 11_000_000n, allow: 1_100_000n, worked: 22, bonus: 53_623_000n },
  { id: "NV23", name: "Đỗ Xuân Thành", base: 10_000_000n, allow: 1_100_000n, worked: 24, bonus: 0n },
];

/** Lợi nhuận công ty tháng 8 sau khi sửa file: −3.475 USD × 26.060. */
export const AUG_COMPANY_PROFIT_VND = -3_475n * 26_060n;
