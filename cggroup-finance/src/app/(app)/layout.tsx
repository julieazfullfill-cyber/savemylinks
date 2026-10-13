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
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:block">
          {([1, 2] as const).map((phase) => {
            const group = screens.filter((s) => s.phase === phase);
            if (!group.length) return null;
            return (
              <div key={phase} className="flex gap-1 md:mb-3 md:block md:space-y-0.5">
                <div className="hidden px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted md:block">
                  {phase === 1 ? "Tài chính" : "Nhân sự & lương"}
                </div>
                {group.map((s) => (
                  <NavLink key={s.href} href={s.href} muted={!s.built}>
                    <span className="w-5 text-right text-xs text-muted tabular-nums">{s.no}</span>
                    {s.label}
                    {!s.built && <span className="ml-auto text-[10px] text-muted">sắp có</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
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
