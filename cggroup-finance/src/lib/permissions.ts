// Phân quyền theo màn hình — đặc tả mục 05. Dùng chung cho middleware và menu.
// Chạy được ở edge runtime: không import Prisma.

export type Role = "ADMIN" | "KE_TOAN" | "QUAN_LY" | "NHAN_VIEN";

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  KE_TOAN: "Kế toán",
  QUAN_LY: "Quản lý / Giám đốc",
  NHAN_VIEN: "Nhân viên",
};

export type Screen = { no: number; href: string; label: string; roles: Role[]; phase: 1 | 2 | 3 | 4; week: number; built?: boolean };

const ALL: Role[] = ["ADMIN", "KE_TOAN", "QUAN_LY", "NHAN_VIEN"];
// Đặc tả GĐ2 ghi "HR" — hệ thống chưa có vai trò HR (không sửa enum của GĐ1),
// nên HR = ADMIN + QUAN_LY. Thêm vai trò riêng khi có người chuyên trách nhân sự.
const HR: Role[] = ["ADMIN", "QUAN_LY"];

export const SCREENS: Screen[] = [
  { no: 1, href: "/tong-quan", label: "Tổng quan tiền", roles: ["ADMIN", "QUAN_LY"], phase: 1, week: 4, built: true },
  { no: 2, href: "/so-quy", label: "Sổ quỹ", roles: ["ADMIN", "KE_TOAN"], phase: 1, week: 2, built: true },
  { no: 3, href: "/chi-phi", label: "Chi phí & duyệt chi", roles: ALL, phase: 1, week: 3, built: true },
  { no: 4, href: "/cong-no", label: "Công nợ, phải thu & thuế", roles: ["ADMIN", "KE_TOAN"], phase: 1, week: 3, built: true },
  { no: 5, href: "/chot-so-du", label: "Chốt số dư", roles: ["ADMIN", "KE_TOAN"], phase: 1, week: 3, built: true },
  { no: 6, href: "/du-bao", label: "Dự báo 13 tuần", roles: ["ADMIN", "QUAN_LY"], phase: 1, week: 5, built: true },
  { no: 7, href: "/pnl", label: "P&L quản trị", roles: ["ADMIN", "QUAN_LY", "KE_TOAN"], phase: 1, week: 4, built: true },
  { no: 8, href: "/danh-muc", label: "Danh mục & người dùng", roles: ["ADMIN"], phase: 1, week: 1, built: true },
  { no: 30, href: "/nhap-du-lieu", label: "Nhập dữ liệu ban đầu", roles: ["ADMIN"], phase: 1, week: 1, built: true },
  { no: 9, href: "/nhan-su", label: "Hồ sơ nhân sự", roles: HR, phase: 2, week: 1, built: true },
  { no: 10, href: "/hop-dong", label: "Hợp đồng & lương", roles: HR, phase: 2, week: 1, built: true },
  { no: 11, href: "/cham-cong", label: "Lưới chấm công", roles: HR, phase: 2, week: 2, built: true },
  { no: 12, href: "/nghi-phep", label: "Nghỉ phép", roles: ALL, phase: 2, week: 2, built: true },
  { no: 13, href: "/ky-luong", label: "Kỳ lương", roles: ["ADMIN", "KE_TOAN", "QUAN_LY"], phase: 2, week: 3, built: true },
  { no: 14, href: "/phieu-luong", label: "Phiếu lương", roles: ALL, phase: 2, week: 4, built: true },
  { no: 15, href: "/kpi", label: "KPI & thưởng", roles: ["ADMIN", "QUAN_LY"], phase: 2, week: 5, built: true },
  // GĐ3 — shop, nhà cung cấp, đơn hàng
  { no: 16, href: "/shop", label: "Danh mục shop", roles: ["ADMIN", "QUAN_LY", "KE_TOAN"], phase: 3, week: 1, built: true },
  { no: 17, href: "/tap-trung", label: "Bản đồ tập trung", roles: ["ADMIN", "QUAN_LY", "KE_TOAN"], phase: 3, week: 1, built: true },
  { no: 18, href: "/suc-khoe-shop", label: "Sức khoẻ shop", roles: ["ADMIN", "QUAN_LY"], phase: 3, week: 1, built: true },
  { no: 19, href: "/ncc", label: "NCC & bảng giá", roles: ["ADMIN", "QUAN_LY", "KE_TOAN"], phase: 3, week: 2, built: true },
  { no: 20, href: "/import-don", label: "Import đơn hàng", roles: ["ADMIN", "KE_TOAN"], phase: 3, week: 3, built: true },
  { no: 21, href: "/don-hang", label: "Đơn hàng", roles: ["ADMIN", "KE_TOAN", "QUAN_LY"], phase: 3, week: 4, built: true },
  { no: 22, href: "/doi-soat", label: "Đối soát payout", roles: ["ADMIN", "KE_TOAN"], phase: 3, week: 7, built: true },
  { no: 23, href: "/bien-lai", label: "Biên lãi theo shop", roles: ["ADMIN", "QUAN_LY", "KE_TOAN"], phase: 3, week: 6, built: true },
  // GĐ4 — sổ cái, phân bổ, đóng sổ, cảnh báo. Màn 25 (P&L theo tháng/team/shop/pháp nhân) gộp vào màn 7.
  { no: 29, href: "/bang-dieu-khien", label: "Bảng điều khiển", roles: ALL, phase: 4, week: 4, built: true },
  { no: 24, href: "/so-cai", label: "Sổ cái", roles: ["ADMIN", "KE_TOAN", "QUAN_LY"], phase: 4, week: 1, built: true },
  { no: 26, href: "/phan-bo", label: "Phân bổ chi phí chung", roles: ["ADMIN", "KE_TOAN", "QUAN_LY"], phase: 4, week: 2, built: true },
  { no: 27, href: "/dong-so", label: "Đóng sổ", roles: ["ADMIN", "KE_TOAN", "QUAN_LY"], phase: 4, week: 3, built: true },
  { no: 28, href: "/canh-bao", label: "Trung tâm cảnh báo", roles: ["ADMIN", "KE_TOAN", "QUAN_LY"], phase: 4, week: 4, built: true },
];

/** Các route không cần đăng nhập. */
export const PUBLIC_PATHS = ["/login"];

export function screenFor(pathname: string): Screen | undefined {
  return SCREENS.find((s) => pathname === s.href || pathname.startsWith(s.href + "/"));
}

export function canAccess(role: Role, pathname: string): boolean {
  if (pathname === "/") return true;
  const s = screenFor(pathname);
  return s ? s.roles.includes(role) : role === "ADMIN";
}

/** Trang đầu sau đăng nhập: bảng điều khiển theo vai trò (màn 29, GĐ4) — mọi vai trò đều vào được. */
export const HOME = "/bang-dieu-khien";

export function homeFor(role: Role): string {
  const allowed = SCREENS.filter((s) => s.roles.includes(role));
  if (allowed.some((s) => s.href === HOME)) return HOME;
  return (allowed.find((s) => s.built) ?? allowed[0])?.href ?? "/";
}
