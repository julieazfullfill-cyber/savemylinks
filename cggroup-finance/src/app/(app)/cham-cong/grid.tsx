"use client";

import { useState } from "react";

type Emp = { id: string; code: string; name: string; online: boolean };
type Day = { date: string; dow: number; holiday: string | null };

const NEXT: Record<string, string> = { "": "1", "1": "0.5", "0.5": "0", "0": "" };
const SHOW: Record<string, string> = { "": "", "1": "1", "0.5": "½", "0": "0" };
const DOW = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

/** Lưới người × ngày. Bấm ô: trống → 1 → ½ → 0 → trống. Gửi toàn bộ ô (ô trống = xoá). */
export function AttendanceGrid({
  action,
  employees,
  days,
  initial,
  leaves,
  locked,
}: {
  action: (f: FormData) => void | Promise<void>;
  employees: Emp[];
  days: Day[];
  initial: Record<string, string>;
  leaves: string[];
  locked: boolean;
}) {
  const [v, setV] = useState<Record<string, string>>(initial);
  const leaveSet = new Set(leaves);
  const key = (e: string, d: string) => `${e}_${d}`;
  const isWork = (d: Day) => d.dow !== 0 && !d.holiday;
  const fill = (ids: string[]) =>
    setV((old) => {
      const n = { ...old };
      for (const id of ids) for (const d of days) if (isWork(d) && !leaveSet.has(key(id, d.date)) && !n[key(id, d.date)]) n[key(id, d.date)] = "1";
      return n;
    });
  const total = (id: string) => days.reduce((s, d) => s + Number(v[key(id, d.date)] || 0), 0);

  return (
    <form action={action}>
      {!locked && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn" onClick={() => fill(employees.map((e) => e.id))}>Điền đủ công cho mọi người</button>
          <span className="text-xs text-muted">Chỉ điền ô trống ngày T2–T7 không phải lễ, bỏ qua ngày đã có đơn nghỉ. Bấm ô để đổi: 1 → ½ → 0 → trống.</span>
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="text-xs" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-[170px] border-b border-hair bg-page px-2 py-1 text-left">Nhân sự</th>
              {days.map((d) => (
                <th
                  key={d.date}
                  title={d.holiday ?? undefined}
                  className={`w-8 border-b border-hair px-0.5 py-1 text-center font-medium ${d.dow === 0 ? "bg-page text-muted" : d.holiday ? "bg-amber-50 text-ink-2" : "text-ink-2"}`}
                >
                  <div>{Number(d.date.slice(8))}</div>
                  <div className="text-[10px] text-muted">{d.holiday ? "Lễ" : DOW[d.dow]}</div>
                </th>
              ))}
              <th className="border-b border-hair px-2 text-right">Công</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <td className="sticky left-0 z-10 border-b border-hair bg-surface px-2 py-1 whitespace-nowrap">
                  <span className="font-mono text-[11px] text-muted">{e.code}</span> {e.name}
                  {e.online && <span className="ml-1 rounded bg-accent/10 px-1 text-[10px] text-accent" title="Làm online — ngày làm vẫn chấm 1">ONL</span>}
                  {!locked && (
                    <button type="button" className="ml-2 text-[10px] text-accent hover:underline" onClick={() => fill([e.id])}>đủ</button>
                  )}
                </td>
                {days.map((d) => {
                  const k = key(e.id, d.date);
                  const val = v[k] ?? "";
                  const leave = leaveSet.has(k);
                  return (
                    <td key={d.date} className={`border-b border-hair p-0 text-center ${d.dow === 0 ? "bg-page" : d.holiday ? "bg-amber-50" : ""}`}>
                      <input type="hidden" name={`a_${e.id}_${d.date}`} value={val} />
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => setV((o) => ({ ...o, [k]: NEXT[o[k] ?? ""] }))}
                        aria-label={`${e.name} ngày ${d.date}: ${val || (leave ? "nghỉ phép" : "trống")}`}
                        className={`h-7 w-8 tabular-nums ${val === "1" ? "font-semibold text-ink" : val === "0" ? "text-crit" : "text-ink-2"} ${locked ? "cursor-not-allowed" : "hover:bg-accent/10"}`}
                      >
                        {SHOW[val] || (leave ? <span className="text-[10px] text-accent">P</span> : "")}
                      </button>
                    </td>
                  );
                })}
                <td className="border-b border-hair px-2 text-right font-semibold tabular-nums">{total(e.id).toLocaleString("vi-VN")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!locked && (
        <div className="mt-3 flex items-center gap-3">
          <button className="btn-primary" type="submit">Lưu chấm công</button>
          <span className="text-xs text-muted">P = có đơn nghỉ đã duyệt (phép có lương được tính công riêng khi tính lương). Cột Công chỉ cộng ngày chấm.</span>
        </div>
      )}
    </form>
  );
}
