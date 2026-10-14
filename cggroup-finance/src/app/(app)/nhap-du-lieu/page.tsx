import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { FIELDS, KIND_VI, KINDS, loadOptions, TARGET_HREF, validate, type Kind } from "@/lib/import-staging";
import { Badge, Flash, PageHead } from "../ui";
import { commitAllAction, saveRowAction } from "./actions";

type SP = { tab?: string; loc?: string; ok?: string; error?: string };
const ts = (d: Date) => d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" });

/** Màn 30 — dữ liệu ban đầu từ seed-data/: điền nốt chỗ trống, chốt từng dòng; dòng đã chốt bị khoá. */
export default async function ImportStagingPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireUser(["ADMIN"]);
  const sp = await searchParams;
  const kind = (KINDS.find((k) => k.toLowerCase() === sp.tab) ?? "ENTITY") as Kind;
  const tab = kind.toLowerCase();
  const loc = sp.loc === "du" || sp.loc === "da-chot" || sp.loc === "tat-ca" ? sp.loc : "thieu";

  const [all, options, users] = await Promise.all([
    prisma.importRow.findMany({ orderBy: [{ createdAt: "asc" }, { key: "asc" }] }),
    loadOptions(prisma),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const stats = Object.fromEntries(
    KINDS.map((k) => {
      const rows = all.filter((r) => r.kind === k);
      const drafts = rows.filter((r) => r.status === "DRAFT");
      const missing = drafts.filter((r) => validate(k, r.data as Record<string, string>).length).length;
      return [k, { total: rows.length, missing, ready: drafts.length - missing, locked: rows.length - drafts.length }];
    }),
  ) as Record<Kind, { total: number; missing: number; ready: number; locked: number }>;
  const rows = all
    .filter((r) => r.kind === kind)
    .map((r) => ({ ...r, d: r.data as Record<string, string>, errs: r.status === "DRAFT" ? validate(kind, r.data as Record<string, string>) : [] }))
    .filter((r) => (loc === "tat-ca" ? true : loc === "da-chot" ? r.status === "LOCKED" : r.status === "DRAFT" && (loc === "thieu" ? r.errs.length > 0 : r.errs.length === 0)));
  const s = stats[kind];
  const totalReady = KINDS.reduce((a, k) => a + stats[k].ready, 0);

  return (
    <div className="max-w-7xl">
      <PageHead no={30} title="Nhập dữ liệu ban đầu">
        {totalReady > 0 && (
          <form action={commitAllAction.bind(null, "tat-ca")}>
            <button className="btn btn-primary" type="submit">Chốt tất cả {totalReady} dòng đã đủ</button>
          </form>
        )}
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <p className="mt-3 max-w-4xl text-sm text-ink-2">
        Danh mục thật nạp từ <code>seed-data/*.csv</code> (<code>npm run import:seed -- --apply</code>). Điền các ô còn trống — ô đỏ là bắt buộc. <strong>Chốt</strong> = ghi vào danh mục
        thật rồi <strong>khoá dòng</strong>: không sửa được ở đây nữa, sửa tiếp ở màn nghiệp vụ (có ghi lịch sử). Chốt theo thứ tự: pháp nhân → tài khoản → nhân viên → shop → hợp đồng.
      </p>
      {!all.length && (
        <p className="card mt-4 p-6 text-sm text-muted">
          Chưa có dữ liệu chờ chốt. Chép CSV vào <code>seed-data/</code> rồi chạy <code>npm run import:seed -- --apply</code>.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        {KINDS.map((k) => (
          <Link key={k} href={`/nhap-du-lieu?tab=${k.toLowerCase()}`} className={`rounded-md px-3 py-1.5 ${k === kind ? "bg-accent text-white" : "bg-surface hover:bg-page"}`}>
            {KIND_VI[k]}{" "}
            <span className={k === kind ? "" : stats[k].missing ? "text-crit" : "text-muted"}>
              {stats[k].locked}/{stats[k].total}
            </span>
          </Link>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {[
          ["thieu", `Còn thiếu (${s.missing})`],
          ["du", `Đủ, chờ chốt (${s.ready})`],
          ["da-chot", `Đã chốt (${s.locked})`],
          ["tat-ca", `Tất cả (${s.total})`],
        ].map(([k, l]) => (
          <Link key={k} href={`/nhap-du-lieu?tab=${tab}&loc=${k}`} className={`rounded-full border px-3 py-1 ${loc === k ? "border-accent text-accent" : "border-hair text-ink-2 hover:bg-page"}`}>{l}</Link>
        ))}
        {s.ready > 0 && (
          <form action={commitAllAction.bind(null, tab)} className="ml-auto">
            <button className="btn" type="submit">Chốt {s.ready} {KIND_VI[kind].toLowerCase()} đã đủ</button>
          </form>
        )}
      </div>

      <div className="mt-3 space-y-3">
        {rows.map((r) =>
          r.status === "LOCKED" ? (
            <div key={r.id} id={`r-${r.id}`} className="card flex flex-wrap items-center gap-x-4 gap-y-1 bg-page/50 p-3 text-sm">
              <Badge tone="good">🔒 Đã chốt</Badge>
              <span className="font-mono text-xs">{r.key}</span>
              <span className="min-w-0 flex-1 truncate text-ink-2">
                {FIELDS[kind].filter((f) => r.d[f.name]).map((f) => `${f.label}: ${r.d[f.name]}`).join(" · ")}
              </span>
              <span className="text-xs text-muted">{userName.get(r.lockedBy ?? "") ?? r.lockedBy} · {r.lockedAt ? ts(r.lockedAt) : ""}</span>
              <Link className="text-xs text-accent hover:underline" href={TARGET_HREF[kind]}>Sửa ở màn nghiệp vụ →</Link>
              {r.note?.includes("Khi chốt:") && <p className="w-full text-xs text-amber-700">{r.note.slice(r.note.indexOf("Khi chốt:"))}</p>}
            </div>
          ) : (
            <form key={r.id} id={`r-${r.id}`} action={saveRowAction.bind(null, r.id)} className={`card p-4 ${r.errs.length ? "border-crit/40" : ""}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-semibold">{r.key}</span>
                {r.errs.length ? <Badge tone="crit">Còn thiếu {r.errs.length}</Badge> : <Badge tone="accent">Đủ — chờ chốt</Badge>}
                {r.note && <span className="text-xs text-ink-2">📝 {r.note}</span>}
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {FIELDS[kind].map((f) => {
                  const v = r.d[f.name] ?? "";
                  const bad = f.required && !v;
                  const id = `${r.id}-${f.name}`;
                  const cls = `input ${bad ? "border-crit bg-red-50" : ""}`;
                  return (
                    <div key={f.name}>
                      <label className="label" htmlFor={id}>
                        {f.label}
                        {f.required && <span className="text-crit"> *</span>}
                      </label>
                      {f.type === "select" ? (
                        <select className={cls} id={id} name={f.name} defaultValue={v}>
                          <option value="">—</option>
                          {(options[f.options!] ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          {v && !(options[f.options!] ?? []).some((o) => o.value === v) && <option value={v}>{v} (không có trong danh mục)</option>}
                        </select>
                      ) : (
                        <input
                          className={cls}
                          id={id}
                          name={f.name}
                          type={f.type === "date" ? "date" : "text"}
                          inputMode={f.type === "money" || f.type === "int" ? "numeric" : undefined}
                          defaultValue={v}
                        />
                      )}
                      {f.help && <p className="mt-0.5 text-[11px] text-muted">{f.help}</p>}
                    </div>
                  );
                })}
              </div>
              {r.errs.length > 0 && <p className="mt-2 text-xs text-crit">{r.errs.join(" · ")}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button className="btn" type="submit" name="intent" value="save">Lưu nháp</button>
                <button className="btn btn-primary" type="submit" name="intent" value="commit">Lưu & chốt</button>
                <span className="text-xs text-muted">sửa lần cuối {ts(r.updatedAt)}{r.updatedBy ? ` · ${userName.get(r.updatedBy) ?? r.updatedBy}` : ""}</span>
              </div>
            </form>
          ),
        )}
        {all.length > 0 && !rows.length && <p className="card p-6 text-center text-sm text-muted">Không có dòng nào ở mục này.</p>}
      </div>
    </div>
  );
}
