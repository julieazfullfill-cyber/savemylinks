import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { homeFor } from "@/lib/permissions";

// Middleware đã chuyển hướng "/" — trang này chỉ là lưới an toàn.
export default async function Home() {
  const s = await getSession();
  redirect(s ? homeFor(s.role) : "/login");
}
