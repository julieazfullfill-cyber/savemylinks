import Link from "next/link";
import { SCREENS } from "@/lib/permissions";

/** Khung cho màn hình chưa làm — ghi rõ tuần dự kiến theo kế hoạch 5 tuần. */
export function ComingSoon({ href, children }: { href: string; children?: React.ReactNode }) {
  const s = SCREENS.find((x) => x.href === href)!;
  return (
    <div className="max-w-2xl">
      <div className="text-xs font-semibold uppercase tracking-widest text-muted">Màn hình {s.no}</div>
      <h1 className="mt-1 text-2xl font-bold">{s.label}</h1>
      <div className="card mt-6 p-5 text-ink-2">
        <p>
          Theo kế hoạch, màn hình này làm ở <strong>tuần {s.week}</strong> của giai đoạn {s.phase === 1 ? "1b" : "2"}.
        </p>
        {children}
        <p className="mt-3">Các màn hình đã nhập được dữ liệu:</p>
        <ul className="mt-1 list-disc pl-5">
          {SCREENS.filter((x) => x.built).map((x) => (
            <li key={x.href}>
              <Link className="text-accent hover:underline" href={x.href}>{x.no}. {x.label}</Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
