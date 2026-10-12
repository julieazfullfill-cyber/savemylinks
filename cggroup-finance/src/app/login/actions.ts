"use server";

import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { canAccess, homeFor } from "@/lib/permissions";
import { SESSION_COOKIE, SESSION_HOURS, signSession } from "@/lib/session";

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "");

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = !!user?.passwordHash && user.active && (await bcrypt.compare(password, user.passwordHash));
  if (!user || !ok) redirect("/login?error=" + encodeURIComponent("Sai email hoặc mật khẩu"));

  (await cookies()).set(SESSION_COOKIE, await signSession({ uid: user.id, name: user.name, role: user.role }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  // Chỉ quay lại đường dẫn nội bộ mà vai trò này được vào.
  redirect(next.startsWith("/") && !next.startsWith("//") && canAccess(user.role, next) ? next : homeFor(user.role));
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
