import Link from "next/link";
import { logout } from "@/app/login/actions";
import { requireUser } from "@/lib/auth";
import { ROLE_LABEL, SCREENS } from "@/lib/permissions";
import { NavLink } from "./nav-link";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const screens = SCREENS.filter((s) => s.roles.includes(user.role));
  return (
    <div className="min-h-screen md:grid md:grid-cols-[230px_1fr]">
      <aside className="border-b border-hair bg-surface md:min-h-screen md:border-r md:border-b-0">
        <div className="px-5 py-4">
          <Link href="/" className="text-xs font-semibold uppercase tracking-widest text-accent">CGGroup</Link>
          <div className="text-base font-bold">Tài chính</div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:block md:space-y-0.5">
          {screens.map((s) => (
            <NavLink key={s.href} href={s.href}>
              <span className="w-4 text-right text-xs text-muted tabular-nums">{s.no}</span>
              {s.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden border-t border-hair px-5 py-4 text-xs md:block">
          <div className="font-semibold">{user.name}</div>
          <div className="text-muted">{ROLE_LABEL[user.role]}</div>
          <form action={logout} className="mt-2">
            <button className="text-accent hover:underline" type="submit">Đăng xuất</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 p-4 md:p-8">{children}</main>
    </div>
  );
}
