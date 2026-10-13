"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** `muted`: màn hình chưa làm — vẫn bấm được để xem kế hoạch, nhưng hiện mờ. */
export function NavLink({ href, muted, children }: { href: string; muted?: boolean; children: React.ReactNode }) {
  const active = usePathname().startsWith(href);
  return (
    <Link
      href={href}
      className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm whitespace-nowrap ${
        active ? "bg-accent/10 font-semibold text-accent" : muted ? "text-muted hover:bg-page" : "text-ink-2 hover:bg-page"
      }`}
    >
      {children}
    </Link>
  );
}
