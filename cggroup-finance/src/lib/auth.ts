import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import type { Role } from "./permissions";
import { SESSION_COOKIE, verifySession, type Session } from "./session";

export async function getSession(): Promise<Session | null> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}

/**
 * Dùng ở đầu mọi server action/page có ghi dữ liệu. Middleware chỉ kiểm cookie;
 * ở đây kiểm lại DB để người dùng bị khoá hoặc đổi vai trò mất quyền ngay.
 */
export async function requireUser(roles?: Role[]): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  const u = await prisma.user.findUnique({ where: { id: s.uid } });
  if (!u || !u.active) redirect("/login?error=" + encodeURIComponent("Tài khoản đã bị khoá"));
  if (roles && !roles.includes(u.role)) throw new Error("Không đủ quyền");
  return { uid: u.id, name: u.name, role: u.role };
}
