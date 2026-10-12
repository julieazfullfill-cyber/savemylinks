// Phiên đăng nhập: JWT ký HS256 trong cookie httpOnly. Chạy được ở edge (middleware).
import { jwtVerify, SignJWT } from "jose";
import type { Role } from "./permissions";

export const SESSION_COOKIE = "cg_session";
export const SESSION_HOURS = 12;

export type Session = { uid: string; name: string; role: Role };

function key(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET chưa đặt hoặc ngắn hơn 32 ký tự");
  return new TextEncoder().encode(s);
}

export async function signSession(s: Session): Promise<string> {
  return new SignJWT({ name: s.name, role: s.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.uid)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key());
}

export async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return { uid: payload.sub, name: String(payload.name), role: payload.role as Role };
  } catch {
    return null;
  }
}
