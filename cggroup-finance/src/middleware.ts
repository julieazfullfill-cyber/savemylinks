import { NextResponse, type NextRequest } from "next/server";
import { canAccess, homeFor, PUBLIC_PATHS } from "@/lib/permissions";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    const url = new URL("/login", req.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (pathname === "/") return NextResponse.redirect(new URL(homeFor(session.role), req.url));
  if (!canAccess(session.role, pathname)) {
    return NextResponse.redirect(new URL(`${homeFor(session.role)}?error=${encodeURIComponent("Không đủ quyền vào " + pathname)}`, req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|.*\\.(?:png|svg|ico|jpg|webp)$).*)"],
};
