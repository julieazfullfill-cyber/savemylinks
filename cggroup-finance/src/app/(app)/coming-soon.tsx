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
      </div>
    </div>
  );
}
