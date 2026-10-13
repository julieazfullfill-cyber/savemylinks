"use client";

import { useActionState } from "react";
import { runImport, type ImportState } from "./actions";

const TONE = { ok: "text-good", skip: "text-muted", error: "text-crit" } as const;
const LABEL = { ok: "Ghi", skip: "Bỏ qua", error: "Lỗi" } as const;

export function ImportForm({ sheets }: { sheets: { name: string; columns: readonly string[] }[] }) {
  const [state, action, pending] = useActionState<ImportState, FormData>(runImport, null);
  const counts = state?.results?.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {} as Record<string, number>);

  return (
    <div>
      <form action={action} className="card p-5">
        <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
          <div>
            <label className="label" htmlFor="sheet">Sheet</label>
            <select className="input" id="sheet" name="sheet" required defaultValue={state?.sheet ?? "GD_Tien"}>
              {sheets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
            <ul className="mt-3 space-y-2 text-xs text-ink-2">
              {sheets.map((s) => (
                <li key={s.name}><strong>{s.name}</strong>: <code className="break-all">{s.columns.join(", ")}</code></li>
              ))}
            </ul>
          </div>
          <div>
            <label className="label" htmlFor="data">Dữ liệu (dán từ Google Sheets / Excel, gồm dòng tiêu đề)</label>
            <textarea className="input h-64 font-mono text-xs" id="data" name="data" required placeholder={"date\taccountCode\tdirection\tamount\tcurrency\tfxRate\tcategoryCode\tsupplierCode\tshopCode\tdescription\n2026-11-02\tAWHK\tIN\t1250,50\tUSD\t\t\t\tAMZ-AU1\tPayout Amazon"} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn" type="submit" name="mode" value="preview" disabled={pending}>{pending ? "Đang xử lý…" : "Xem trước (không ghi)"}</button>
          <button className="btn-primary" type="submit" name="mode" value="commit" disabled={pending}>Nạp vào hệ thống</button>
        </div>
      </form>

      {state?.error && <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-crit">{state.error}</p>}
      {state?.results && (
        <section className="mt-4">
          <div className="flex flex-wrap items-baseline gap-4 text-sm">
            <h2 className="font-bold">{state.dryRun ? "Xem trước — chưa ghi gì" : "Đã nạp"}: {state.sheet}</h2>
            <span className="text-good">{counts?.ok ?? 0} ghi</span>
            <span className="text-muted">{counts?.skip ?? 0} bỏ qua (trùng)</span>
            <span className="text-crit">{counts?.error ?? 0} lỗi</span>
          </div>
          <div className="card mt-2 max-h-[480px] overflow-auto">
            <table className="tbl text-xs">
              <thead><tr><th>Dòng</th><th>Kết quả</th><th>Chi tiết</th></tr></thead>
              <tbody>
                {state.results.map((r) => (
                  <tr key={r.line}>
                    <td className="tabular-nums">{r.line}</td>
                    <td className={`font-semibold ${TONE[r.status]}`}>{LABEL[r.status]}</td>
                    <td>{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
