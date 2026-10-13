import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { CATALOGS, catalogByKey, type Catalog, type Field, type RefSource } from "@/lib/catalog";
import { bizDateStr, fmtBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { saveCatalogItem } from "../actions";

type Row = Record<string, unknown>;
type RefOptions = Record<RefSource, { value: string; label: string }[]>;

async function loadRefs(): Promise<RefOptions> {
  const [accounts, entities, users, providers] = await Promise.all([
    prisma.account.findMany({ orderBy: { code: "asc" } }),
    prisma.legalEntity.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.user.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.cashProvider.findMany({ orderBy: { name: "asc" } }),
  ]);
  const acc = (a: (typeof accounts)[number]) => ({ value: a.code, label: `${a.code} · ${a.name}` });
  return {
    account: accounts.map(acc),
    assetAccount: accounts.filter((a) => a.type === "ASSET").map(acc),
    entity: entities.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` })),
    user: users.map((u) => ({ value: u.id, label: u.name })),
    provider: providers.map((p) => ({ value: p.id, label: p.active ? p.name : `${p.name} (ngưng)` })),
  };
}

async function loadRows(cat: Catalog): Promise<Row[]> {
  // Tài khoản tiền xếp theo nhóm rồi mã — các tài khoản cùng Payoneer/Airwallex nằm cạnh nhau.
  const orderBy =
    cat.model === "user"
      ? { email: "asc" as const }
      : cat.model === "cashAccount"
        ? [{ provider: { name: "asc" as const } }, { code: "asc" as const }]
        : { code: "asc" as const };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any)[cat.model].findMany({ orderBy });
}

function display(f: Field, v: unknown, refs: RefOptions): React.ReactNode {
  if (v === null || v === undefined || v === "") return <span className="text-muted">—</span>;
  switch (f.type) {
    case "bool":
      return v ? "✓" : <span className="text-muted">✗</span>;
    case "vnd":
      return <span className="tabular-nums">{formatMoney(v as bigint)}</span>;
    case "date":
      return fmtBizDate(v as Date);
    case "ref":
      return refs[f.ref!].find((o) => o.value === v)?.label ?? String(v);
    case "select":
      return f.optionLabels?.[String(v)] ?? String(v);
    default:
      return String(v);
  }
}

function formValue(f: Field, row: Row | null): string {
  const v = row?.[f.name];
  if (row === null) return typeof f.default === "string" ? f.default : "";
  if (v === null || v === undefined) return "";
  if (f.type === "date") return bizDateStr(v as Date);
  return String(v);
}

function Input({ f, row, refs }: { f: Field; row: Row | null; refs: RefOptions }) {
  const locked = f.immutable && row !== null;
  const common = { id: f.name, name: f.name, disabled: locked, required: f.required && !locked && f.type !== "password" };
  if (f.type === "bool") {
    const checked = row ? Boolean(row[f.name]) : f.default === true;
    return (
      <label className="flex items-center gap-2 pt-6 text-sm">
        <input type="checkbox" {...common} defaultChecked={checked} /> {f.label}
      </label>
    );
  }
  let control: React.ReactNode;
  if (f.type === "select" || f.type === "ref") {
    const opts = f.type === "select" ? f.options!.map((o) => ({ value: o, label: f.optionLabels?.[o] ?? o })) : refs[f.ref!];
    control = (
      <select className="input" {...common} defaultValue={formValue(f, row)}>
        {!f.required && <option value="">—</option>}
        {opts.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  } else {
    const type = { int: "number", date: "date", email: "email", password: "password" }[f.type as string] ?? "text";
    control = (
      <input
        className="input"
        type={type}
        min={f.min}
        max={f.max}
        inputMode={f.type === "vnd" ? "numeric" : undefined}
        autoComplete={f.type === "password" ? "new-password" : "off"}
        {...common}
        defaultValue={f.type === "password" ? "" : formValue(f, row)}
      />
    );
  }
  return (
    <div>
      <label className="label" htmlFor={f.name}>
        {f.label}
        {f.required && !locked && <span className="text-crit"> *</span>}
      </label>
      {control}
      {f.help && <p className="mt-1 text-xs text-muted">{f.help}</p>}
    </div>
  );
}

export default async function CatalogPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{ edit?: string; error?: string; ok?: string }>;
}) {
  await requireUser(["ADMIN"]);
  const { kind } = await params;
  const { edit, error, ok } = await searchParams;
  const cat = catalogByKey(kind);
  if (!cat) notFound();

  const [rows, refs] = await Promise.all([loadRows(cat), loadRefs()]);
  const editing = edit === "new" ? null : rows.find((r) => String(r[cat.idField]) === edit);
  const showForm = edit === "new" || editing !== undefined;
  const listFields = cat.fields.filter((f) => !f.hideInList);
  const save = saveCatalogItem.bind(null, cat.key, editing ? String(editing[cat.idField]) : null);

  return (
    <div className="max-w-6xl">
      <div className="text-xs font-semibold uppercase tracking-widest text-muted">Màn hình 8</div>
      <h1 className="mt-1 text-2xl font-bold">Danh mục & người dùng</h1>

      <div className="mt-5 flex gap-1 overflow-x-auto border-b border-hair">
        {CATALOGS.map((c) => (
          <Link
            key={c.key}
            href={`/danh-muc/${c.key}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
              c.key === cat.key ? "border-accent font-semibold text-accent" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {c.label}
          </Link>
        ))}
      </div>

      {ok && <p className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-good">{ok}</p>}

      {showForm ? (
        <form action={save} className="card mt-4 p-5">
          <h2 className="font-bold">{editing ? `Sửa ${cat.label.toLowerCase()}` : `Thêm ${cat.label.toLowerCase()}`}</h2>
          {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-crit">{error}</p>}
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cat.fields.map((f) => (
              <Input key={f.name} f={f} row={editing ?? null} refs={refs} />
            ))}
          </div>
          <div className="mt-5 flex gap-2">
            <button className="btn-primary" type="submit">Lưu</button>
            <Link className="btn" href={`/danh-muc/${cat.key}`}>Huỷ</Link>
          </div>
        </form>
      ) : (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted">{rows.length} mục · không xoá được, bỏ chọn “Đang dùng” để ngưng.</p>
          <Link className="btn-primary" href={`/danh-muc/${cat.key}?edit=new`}>+ Thêm</Link>
        </div>
      )}

      <div className="card mt-4 overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              {listFields.map((f) => (
                <th key={f.name}>{f.label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const id = String(r[cat.idField]);
              return (
                <tr key={id} className={r.active === false ? "opacity-50" : ""}>
                  {listFields.map((f) => (
                    <td key={f.name} className={f.name === "code" ? "font-mono text-xs" : ""}>
                      {display(f, r[f.name], refs)}
                    </td>
                  ))}
                  <td className="text-right">
                    <Link className="text-accent hover:underline" href={`/danh-muc/${cat.key}?edit=${encodeURIComponent(id)}`}>Sửa</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
