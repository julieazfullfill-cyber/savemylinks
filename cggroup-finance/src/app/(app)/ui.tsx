// Mảnh giao diện dùng chung cho các màn hình nghiệp vụ.

export function PageHead({ no, title, children }: { no: number; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="text-xs font-semibold uppercase tracking-widest text-muted">Màn hình {no}</div>
        <h1 className="mt-1 text-2xl font-bold">{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (error) return <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-crit">{error}</p>;
  if (ok) return <p className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-good">{ok}</p>;
  return null;
}

type Opt = { value: string; label: string };

export function Field({
  name, label, required, help, type = "text", defaultValue, options, empty = "—", ...rest
}: {
  name: string;
  label: string;
  required?: boolean;
  help?: string;
  type?: string;
  defaultValue?: string | null;
  options?: Opt[];
  empty?: string | false;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "defaultValue">) {
  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
        {required && <span className="text-crit"> *</span>}
      </label>
      {options ? (
        <select className="input" id={name} name={name} required={required} defaultValue={defaultValue ?? ""}>
          {empty !== false && <option value="">{empty}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : (
        <input className="input" id={name} name={name} type={type} required={required} defaultValue={defaultValue ?? ""} {...rest} />
      )}
      {help && <p className="mt-1 text-xs text-muted">{help}</p>}
    </div>
  );
}

export function Badge({ tone = "muted", children }: { tone?: "muted" | "good" | "crit" | "accent"; children: React.ReactNode }) {
  const cls = {
    muted: "bg-page text-ink-2",
    good: "bg-green-50 text-good",
    crit: "bg-red-50 text-crit",
    accent: "bg-accent/10 text-accent",
  }[tone];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}
