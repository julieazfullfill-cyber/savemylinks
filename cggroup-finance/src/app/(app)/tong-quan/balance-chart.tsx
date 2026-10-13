"use client";

import { useEffect, useRef, useState } from "react";
import { compactVnd, niceTicks } from "@/lib/overview";

type Point = { date: string; vnd: number; missingRate: boolean };

const H = 240;
const M = { top: 14, right: 84, bottom: 26, left: 62 };
// Một chuỗi duy nhất → màu nhấn slot 1; lưới/trục lùi về sau.
const C = { line: "#2a78d6", grid: "#eef0f4", axis: "#767e8b", ink: "#11141a", surface: "#ffffff" };

const ddmm = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const full = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/** Số dư quy VND theo ngày — đường + vùng nhạt, crosshair theo con trỏ hoặc phím ← →. */
export function BalanceChart({ points }: { points: Point[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!points.length) return null;
  const values = points.map((p) => p.vnd);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const x = (i: number) => M.left + (points.length === 1 ? iw : (i / (points.length - 1)) * iw);
  const y = (v: number) => M.top + ih - ((v - y0) / (y1 - y0 || 1)) * ih;

  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.vnd).toFixed(1)}`).join("");
  const area = `${line}L${x(points.length - 1).toFixed(1)},${y(Math.max(y0, 0))}L${x(0).toFixed(1)},${y(Math.max(y0, 0))}Z`;
  const last = points.length - 1;
  const xLabels = [0, Math.round(last / 3), Math.round((2 * last) / 3), last];

  const pick = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    const i = Math.round(((clientX - r.left - M.left) / iw) * last);
    setHover(Math.min(last, Math.max(0, i)));
  };
  const h = hover ?? null;

  return (
    <div ref={wrap} className="relative w-full select-none">
      <svg
        width={W}
        height={H}
        role="img"
        aria-label={`Số dư quy VND ${points.length} ngày, từ ${full(points[0].date)} đến ${full(points[last].date)}; cuối kỳ ${compactVnd(points[last].vnd)}`}
        tabIndex={0}
        className="block outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setHover((v) => Math.max(0, (v ?? last) - 1));
          if (e.key === "ArrowRight") setHover((v) => Math.min(last, (v ?? last) + 1));
          if (e.key === "Escape") setHover(null);
        }}
        onBlur={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "#d5dae1" : C.grid} strokeWidth={1} />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={C.axis} style={{ fontVariantNumeric: "tabular-nums" }}>
              {t === 0 ? "0" : compactVnd(t)}
            </text>
          </g>
        ))}
        {xLabels.map((i, k) => (
          <text key={k} x={x(i)} y={H - 6} textAnchor={k === 0 ? "start" : k === 3 ? "end" : "middle"} fontSize={11} fill={C.axis}>
            {ddmm(points[i].date)}
          </text>
        ))}

        <path d={area} fill={C.line} opacity={0.1} />
        <path d={line} fill="none" stroke={C.line} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* điểm cuối + nhãn giá trị */}
        <circle cx={x(last)} cy={y(points[last].vnd)} r={4} fill={C.line} stroke={C.surface} strokeWidth={2} />
        <text x={x(last) + 9} y={y(points[last].vnd)} dy="0.32em" fontSize={12} fontWeight={600} fill={C.ink}>
          {compactVnd(points[last].vnd)}
        </text>

        {h !== null && (
          <g pointerEvents="none">
            <line x1={x(h)} x2={x(h)} y1={M.top} y2={M.top + ih} stroke={C.axis} strokeWidth={1} />
            <circle cx={x(h)} cy={y(points[h].vnd)} r={5} fill={C.line} stroke={C.surface} strokeWidth={2} />
          </g>
        )}
      </svg>

      {h !== null && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-hair bg-surface px-3 py-2 text-xs shadow-sm"
          style={x(h) > W / 2 ? { right: W - x(h) + 10 } : { left: x(h) + 10 }}
        >
          <div className="text-sm font-semibold">{points[h].vnd.toLocaleString("vi-VN")} ₫</div>
          <div className="text-muted">{full(points[h].date)}</div>
          {points[h].missingRate && <div className="text-crit">USD chưa có tỷ giá — chưa tính</div>}
        </div>
      )}
    </div>
  );
}
