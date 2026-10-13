import { requireUser } from "@/lib/auth";
import { addDays, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { CONCENTRATION_LIMIT } from "@/lib/order-alerts";
import { incomeByAccount } from "@/lib/shops";
import { PageHead } from "../ui";

const PERIODS = [30, 90, 180, 365];

/** Màn 17 — tỷ trọng tiền thu từ shop theo tài khoản nhận. Một tài khoản bị giam = mất phần đó. */
export default async function ConcentrationPage({ searchParams }: { searchParams: Promise<{ ngay?: string }> }) {
  await requireUser(["ADMIN", "QUAN_LY", "KE_TOAN"]);
  const sp = await searchParams;
  const days = PERIODS.includes(Number(sp.ngay)) ? Number(sp.ngay) : 90;
  const to = todayVn();
  const from = addDays(to, -days + 1);
  const rows = await prisma.$transaction((tx) => incomeByAccount(tx, from, to));
  const total = rows.reduce((a, r) => a + r.vnd, 0n);
  const top = rows[0];
  const over = rows.filter((r) => r.share > CONCENTRATION_LIMIT);

  return (
    <div className="max-w-5xl">
      <PageHead no={17} title="Bản đồ tập trung dòng tiền">
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <a key={p} href={`/tap-trung?ngay=${p}`} className={p === days ? "btn-primary" : "btn"}>{p} ngày</a>
          ))}
        </div>
      </PageHead>
      <p className="mt-2 max-w-3xl text-sm text-ink-2">
        Tỷ trọng tiền thu từ shop ({fmtBizDate(from)} – {fmtBizDate(to)}) theo tài khoản nhận. Ngưỡng an toàn {Math.round(CONCENTRATION_LIMIT * 100)}% —
        một lệnh giam tài khoản vượt ngưỡng là mất phần lớn khả năng chi trả. Tỷ trọng tính trên tiền quy VND theo tỷ giá ngày nhận.
      </p>

      {top && (
        <div className={`mt-4 rounded-lg border p-4 ${over.length ? "border-crit/40 bg-red-50" : "border-hair bg-surface"}`}>
          {over.length ? (
            <p className="font-semibold text-crit">⛔ {over.map((r) => `${r.name} ${(r.share * 100).toFixed(1)}%`).join(", ")} — vượt ngưỡng {Math.round(CONCENTRATION_LIMIT * 100)}%</p>
          ) : (
            <p className="font-semibold text-good">✓ Không tài khoản nào vượt {Math.round(CONCENTRATION_LIMIT * 100)}% (cao nhất: {top.name} {(top.share * 100).toFixed(1)}%)</p>
          )}
          <p className="mt-1 text-sm text-ink-2">Gợi ý: mở thêm cổng nhận tiền song song và rút về tài khoản công ty theo lịch cố định.</p>
        </div>
      )}

      <div className="card mt-4 p-5">
        {rows.length === 0 ? (
          <p className="text-center text-sm text-muted">Chưa có khoản thu từ shop nào trong kỳ — ghi ở Sổ quỹ (Thu từ shop) hoặc màn 22 Đối soát payout.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => {
              const pct = r.share * 100;
              const bad = r.share > CONCENTRATION_LIMIT;
              return (
                <li key={r.accountId}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span><span className="font-mono text-xs text-muted">{r.code}</span> {r.name}</span>
                    <span className="tabular-nums">
                      {formatMoney(r.vnd)} · <strong className={bad ? "text-crit" : ""}>{pct.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%</strong>
                      {bad && <span className="ml-1 text-xs text-crit">⚠ vượt ngưỡng</span>}
                    </span>
                  </div>
                  <div className="relative mt-1 h-2.5 rounded-full bg-accent/15" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Tỷ trọng ${r.code}`}>
                    <div className={`h-2.5 rounded-full ${bad ? "bg-crit" : "bg-accent"}`} style={{ width: `${Math.max(1, pct)}%` }} />
                    <div className="absolute top-[-3px] h-4 w-px bg-ink-2" style={{ left: `${CONCENTRATION_LIMIT * 100}%` }} title="Ngưỡng 40%" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {rows.length > 0 && <p className="mt-4 text-xs text-muted">Tổng {formatMoney(total)}. Vạch dọc = ngưỡng {Math.round(CONCENTRATION_LIMIT * 100)}%.</p>}
      </div>
    </div>
  );
}
