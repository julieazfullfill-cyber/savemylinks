// Phân quyền theo màn hình — đặc tả mục 05. Dùng chung cho middleware và menu.
// Chạy được ở edge runtime: không import Prisma.

export type Role = "ADMIN" | "KE_TOAN" | "QUAN_LY" | "NHAN_VIEN";

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  KE_TOAN: "Kế toán",
  QUAN_LY: "Quản lý / Giám đốc",
  NHAN_VIEN: "Nhân viên",
};

export type Screen = { no: number; href: string; label: string; roles: Role[]; week: number };

export const SCREENS: Screen[] = [
  { no: 1, href: "/tong-quan", label: "Tổng quan tiền", roles: ["ADMIN", "QUAN_LY"], week: 4 },
  { no: 2, href: "/so-quy", label: "Sổ quỹ", roles: ["ADMIN", "KE_TOAN"], week: 2 },
  { no: 3, href: "/chi-phi", label: "Chi phí & duyệt chi", roles: ["ADMIN", "KE_TOAN", "QUAN_LY", "NHAN_VIEN"], week: 3 },
  { no: 4, href: "/cong-no", label: "Công nợ nhà cung cấp", roles: ["ADMIN", "KE_TOAN"], week: 3 },
  { no: 5, href: "/chot-so-du", label: "Chốt số dư", roles: ["ADMIN", "KE_TOAN"], week: 3 },
  { no: 6, href: "/du-bao", label: "Dự báo 13 tuần", roles: ["ADMIN", "QUAN_LY"], week: 5 },
  { no: 7, href: "/pnl", label: "P&L quản trị", roles: ["ADMIN", "QUAN_LY", "KE_TOAN"], week: 4 },
  { no: 8, href: "/danh-muc", label: "Danh mục & người dùng", roles: ["ADMIN"], week: 1 },
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

export function homeFor(role: Role): string {
  return SCREENS.find((s) => s.roles.includes(role))?.href ?? "/";
}
