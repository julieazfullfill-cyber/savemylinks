import { compactVnd, niceTicks } from "@/lib/overview";

/**
 * Số dư cuối tuần — cột, một màu; tuần âm dùng màu "nghiêm trọng" kèm nhãn (không chỉ dựa vào màu).
 * Vạch ngưỡng tối thiểu là đường liền mảnh có chữ. Mỗi cột có <title> làm tooltip; bảng bên dưới là bản số liệu.
 */
export function ForecastChart({ rows, floor }: { rows: { week: number; label: string; closing: number }[]; floor: number }) {
  const W = 760;
  const H = 260;
  const M = { top: 16, right: 16, bottom: 30, left: 64 };
  const vals = rows.map((r) => r.closing);
  const ticks = niceTicks(Math.min(0, floor, ...vals), Math.max(0, floor, ...vals));
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const y = (v: number) => M.top + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  const slot = iw / rows.length;
  const bw = Math.min(24, slot * 0.6);
  const zero = y(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Số dư dự kiến cuối mỗi tuần, 13 tuần tới">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "#c9cfd8" : "#eef0f4"} strokeWidth={1} />
          <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="#767e8b">{t === 0 ? "0" : compactVnd(t)}</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const cx = M.left + slot * i + slot / 2;
        const top = Math.min(y(r.closing), zero);
        const h = Math.max(1, Math.abs(y(r.closing) - zero));
        const neg = r.closing < 0;
        const rx = Math.min(4, h / 2);
        // đầu cột bo 4px, chân cột vuông tại đường 0
        const d = neg
          ? `M${cx - bw / 2},${top}h${bw}v${h - rx}a${rx},${rx} 0 0 1 ${-rx},${rx}h${-(bw - 2 * rx)}a${rx},${rx} 0 0 1 ${-rx},${-rx}z`
          : `M${cx - bw / 2},${top + h}v${-(h - rx)}a${rx},${rx} 0 0 1 ${rx},${-rx}h${bw - 2 * rx}a${rx},${rx} 0 0 1 ${rx},${rx}v${h - rx}z`;
        return (
          <g key={r.week}>
            <path d={d} fill={neg ? "#d03b3b" : "#2a78d6"}>
              <title>{`Tuần ${r.week} (${r.label}): ${r.closing.toLocaleString("vi-VN")} ₫`}</title>
            </path>
            {(i === 0 || i === rows.length - 1 || neg) && (
              <text x={cx} y={neg ? top + h + 13 : top - 5} textAnchor="middle" fontSize={10.5} fill="#11141a" fontWeight={600}>
                {compactVnd(r.closing)}
              </text>
            )}
            <text x={cx} y={H - 10} textAnchor="middle" fontSize={10.5} fill="#767e8b">T{r.week}</text>
          </g>
        );
      })}
      {floor !== 0 && (
        <g>
          <line x1={M.left} x2={W - M.right} y1={y(floor)} y2={y(floor)} stroke="#d03b3b" strokeWidth={1} />
          <text x={W - M.right} y={y(floor) - 5} textAnchor="end" fontSize={10.5} fill="#b32f2f">Ngưỡng tối thiểu {compactVnd(floor)}</text>
        </g>
      )}
    </svg>
  );
}
