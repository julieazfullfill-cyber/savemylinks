// Phân quyền theo màn hình — đặc tả mục 05. Dùng chung cho middleware và menu.
// Chạy được ở edge runtime: không import Prisma.

export type Role = "ADMIN" | "KE_TOAN" | "QUAN_LY" | "NHAN_VIEN";

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  KE_TOAN: "Kế toán",
  QUAN_LY: "Quản lý / Giám đốc",
  NHAN_VIEN: "Nhân viên",
};

export type Screen = { no: number; href: string; label: string; roles: Role[]; phase: 1 | 2; week: number; built?: boolean };

const ALL: Role[] = ["ADMIN", "KE_TOAN", "QUAN_LY", "NHAN_VIEN"];
// Đặc tả GĐ2 ghi "HR" — hệ thống chưa có vai trò HR (không sửa enum của GĐ1),
// nên HR = ADMIN + QUAN_LY. Thêm vai trò riêng khi có người chuyên trách nhân sự.
const HR: Role[] = ["ADMIN", "QUAN_LY"];

export const SCREENS: Screen[] = [
  { no: 1, href: "/tong-quan", label: "Tổng quan tiền", roles: ["ADMIN", "QUAN_LY"], phase: 1, week: 4, built: true },
  { no: 2, href: "/so-quy", label: "Sổ quỹ", roles: ["ADMIN", "KE_TOAN"], phase: 1, week: 2, built: true },
  { no: 3, href: "/chi-phi", label: "Chi phí & duyệt chi", roles: ALL, phase: 1, week: 3, built: true },
  { no: 4, href: "/cong-no", label: "Công nợ nhà cung cấp", roles: ["ADMIN", "KE_TOAN"], phase: 1, week: 3, built: true },
  { no: 5, href: "/chot-so-du", label: "Chốt số dư", roles: ["ADMIN", "KE_TOAN"], phase: 1, week: 3, built: true },
  { no: 6, href: "/du-bao", label: "Dự báo 13 tuần", roles: ["ADMIN", "QUAN_LY"], phase: 1, week: 5, built: true },
  { no: 7, href: "/pnl", label: "P&L quản trị", roles: ["ADMIN", "QUAN_LY", "KE_TOAN"], phase: 1, week: 4, built: true },
  { no: 8, href: "/danh-muc", label: "Danh mục & người dùng", roles: ["ADMIN"], phase: 1, week: 1, built: true },
  { no: 9, href: "/nhan-su", label: "Hồ sơ nhân sự", roles: HR, phase: 2, week: 1, built: true },
  { no: 10, href: "/hop-dong", label: "Hợp đồng & lương", roles: HR, phase: 2, week: 1, built: true },
  { no: 11, href: "/cham-cong", label: "Lưới chấm công", roles: HR, phase: 2, week: 2, built: true },
  { no: 12, href: "/nghi-phep", label: "Nghỉ phép", roles: ALL, phase: 2, week: 2, built: true },
  { no: 13, href: "/ky-luong", label: "Kỳ lương", roles: ["ADMIN", "KE_TOAN", "QUAN_LY"], phase: 2, week: 3, built: true },
  { no: 14, href: "/phieu-luong", label: "Phiếu lương", roles: ALL, phase: 2, week: 4, built: true },
  { no: 15, href: "/kpi", label: "KPI & thưởng", roles: ["ADMIN", "QUAN_LY"], phase: 2, week: 5, built: true },
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

/** Trang đầu sau đăng nhập: màn đã làm xong đầu tiên mà vai trò được vào. */
export function homeFor(role: Role): string {
  const allowed = SCREENS.filter((s) => s.roles.includes(role));
  return (allowed.find((s) => s.built) ?? allowed[0])?.href ?? "/";
}
