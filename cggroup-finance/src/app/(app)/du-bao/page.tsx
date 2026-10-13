import { requireUser } from "@/lib/auth";
import { bizDateStr, fmtBizDate, startOfWeek, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { buildForecast, firstWeekBelow } from "@/lib/forecast";
import { loadForecastInput } from "@/lib/forecast-data";
import { formatMoney, toMinor, type Currency } from "@/lib/money";
import { balanceSeries, compactVnd } from "@/lib/overview";
import { Badge, Field, Flash, PageHead } from "../ui";
import { addItem, removeItem, saveSnapshot } from "./actions";
import { ForecastChart } from "./forecast-chart";

type SP = { rf?: string; ff?: string; floor?: string; name?: string; ok?: string; error?: string };
type SavedRow = { week: number; to: string; closing: string };
type SavedScenario = { name?: string; revenueFactor?: number; ffRate?: number; floorVnd?: string };

const ddmm = (d: Date) => fmtBizDate(d).slice(0, 5);

export default async function ForecastPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireUser(["ADMIN", "QUAN_LY"]);
  const sp = await searchParams;
  const today = todayVn();
  const start = startOfWeek(today);

  const snapshots = await prisma.forecastSnapshot.findMany({ orderBy: { createdAt: "desc" }, take: 6 });
  const lastScenario = (snapshots[0]?.scenario ?? {}) as SavedScenario;

  const num = (s: string | undefined) => (s && s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : undefined);
  let floor = 0n;
  try {
    floor = toMinor(sp.floor ?? lastScenario.floorVnd ?? "0", "VND");
  } catch {}

  const { input, defaults, missingRate, payrollCost, pendingOrders, filings } = await prisma.$transaction((tx) =>
    loadForecastInput(tx, { startDate: start, scenario: { name: sp.name, revenueFactor: num(sp.rf), ffRate: num(sp.ff) } }),
  );
  const rows = buildForecast(input);
  const breach = firstWeekBelow(rows, floor);
  const lowest = rows.reduce((m, r) => (r.closing < m.closing ? r : m), rows[0]);
  const items = await prisma.forecastItem.findMany({ orderBy: { expectedOn: "asc" } });

  // Độ lệch các lần dự báo đã lưu: tuần đã qua, dự báo số dư cuối tuần so với thực tế.
  const [txns, rates] = await Promise.all([
    prisma.cashTxn.findMany({ where: { voidedAt: null }, select: { accountId: true, date: true, direction: true, amount: true, currency: true } }),
    prisma.fxRate.findMany({ where: { base: "USD", quote: "VND" }, orderBy: { date: "asc" } }),
  ]);
  const oldest = snapshots.at(-1)?.weekStart ?? today;
  const actual = new Map(
    balanceSeries(
      txns.map((t) => ({ ...t, currency: t.currency as Currency })),
      rates.map((r) => ({ date: r.date, rate: r.rate.toString() })),
      oldest,
      today,
    ).map((p) => [p.date, p.vnd]),
  );
  const accuracy = snapshots
    .flatMap((s) =>
      ((s.rows as unknown as SavedRow[]) ?? [])
        .filter((r) => r.to.slice(0, 10) < bizDateStr(today))
        .map((r) => {
          const predicted = BigInt(r.closing);
          const real = actual.get(r.to.slice(0, 10));
          return { snap: s, week: r.week, to: r.to.slice(0, 10), predicted, real };
        }),
    )
    .filter((a) => a.real !== undefined)
    .slice(0, 12);

  const keep = new URLSearchParams();
  for (const k of ["rf", "ff", "floor", "name"] as const) if (sp[k]) keep.set(k, sp[k]!);
  const qs = keep.toString();

  return (
    <div className="max-w-7xl">
      <PageHead no={6} title="Dự báo dòng tiền 13 tuần" />
      <Flash ok={sp.ok} error={sp.error} />

      {/* Đòn bẩy kịch bản */}
      <form method="get" className="card mt-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field name="name" label="Tên kịch bản" defaultValue={input.scenario.name} />
        <Field name="rf" label="Hệ số doanh thu" type="number" step="0.05" min="0.1" max="3" defaultValue={String(input.scenario.revenueFactor)} help="1 = như trung bình 3 tháng; 0,8 = giảm 20%" />
        <Field name="ff" label="Tỷ lệ giá vốn" type="number" step="0.01" min="0" max="0.95" defaultValue={String(input.scenario.ffRate)} help={defaults.ffRateFromHistory ? `Lịch sử 90 ngày: ${(defaults.ffRate * 100).toFixed(1)}%` : "Chưa có lịch sử — mặc định 35%"} />
        <Field name="floor" label="Ngưỡng số dư tối thiểu (đ)" inputMode="numeric" defaultValue={floor ? floor.toString() : ""} placeholder="200.000.000" help="Tuần nào xuống dưới sẽ cảnh báo" />
        <div className="flex items-end gap-2">
          <button className="btn-primary" type="submit">Tính lại</button>
          <a className="btn" href="/du-bao">Mặc định</a>
        </div>
      </form>

      {missingRate && <p className="mt-3 text-sm text-crit">⚠ Chưa có tỷ giá USD — số dư USD chưa được tính vào số mở đầu.</p>}

      {/* Tóm tắt */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <div className="text-xs text-ink-2">Số dư mở đầu (khả dụng)</div>
          <div className="mt-1 text-xl font-semibold">{compactVnd(Number(input.openingAvailableVnd))}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-ink-2">Thấp nhất trong 13 tuần</div>
          <div className={`mt-1 text-xl font-semibold ${lowest.closing < 0n ? "text-crit" : ""}`}>{compactVnd(Number(lowest.closing))}</div>
          <div className="text-xs text-muted">tuần {lowest.week} ({ddmm(lowest.from)}–{ddmm(lowest.to)})</div>
        </div>
        <div className={`rounded-lg border p-4 ${breach ? "border-crit/40 bg-red-50" : "border-hair bg-surface"}`}>
          <div className="text-xs text-ink-2">So với ngưỡng {compactVnd(Number(floor))}</div>
          {breach ? (
            <div className="mt-1 font-semibold text-crit">⛔ Chạm đáy tuần {breach.week} ({ddmm(breach.from)}–{ddmm(breach.to)})</div>
          ) : (
            <div className="mt-1 font-semibold text-good">✓ Không tuần nào xuống dưới ngưỡng</div>
          )}
        </div>
      </div>

      <section className="card mt-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-bold">Số dư cuối tuần</h2>
          {floor > 0n && (
            <span className="flex items-center gap-2 text-xs text-ink-2">
              <span className="inline-block h-px w-6 bg-crit" aria-hidden /> Ngưỡng tối thiểu {compactVnd(Number(floor))}
            </span>
          )}
        </div>
        <div className="mt-2">
          <ForecastChart rows={rows.map((r) => ({ week: r.week, label: `${ddmm(r.from)}–${ddmm(r.to)}`, closing: Number(r.closing) }))} floor={Number(floor)} />
        </div>
      </section>

      <div className="card mt-4 overflow-x-auto">
        <table className="tbl text-xs">
          <thead>
            <tr>
              <th>Tuần</th><th className="text-right">Mở đầu</th><th className="text-right">Tiền giam về</th><th className="text-right">Đơn chờ về</th><th className="text-right">Doanh thu về</th>
              <th className="text-right">Thu khác</th><th className="text-right">Hoá đơn NCC</th><th className="text-right">Giá vốn FF</th>
              <th className="text-right">Định kỳ</th><th className="text-right">Chi khác</th><th className="text-right">Chênh lệch</th><th className="text-right">Cuối tuần</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.week} className={floor && r.closing < floor ? "bg-red-50" : ""}>
                <td className="whitespace-nowrap">T{r.week} · {ddmm(r.from)}–{ddmm(r.to)}</td>
                {[r.opening, r.reserveIn, r.pipelineIn, r.revenueIn, r.manualIn, -r.billsOut, -r.cogsOut, -r.fixedOut, -r.manualOut, r.net].map((v, i) => (
                  <td key={i} className={`whitespace-nowrap text-right tabular-nums ${v < 0n ? "text-crit" : ""}`}>{v === 0n ? <span className="text-muted">—</span> : compactVnd(Number(v))}</td>
                ))}
                <td className={`whitespace-nowrap text-right font-semibold tabular-nums ${r.closing < 0n ? "text-crit" : ""}`}>{compactVnd(Number(r.closing))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-muted">
        Doanh thu: trung bình thu từ shop 90 ngày qua × hệ số, về theo chu kỳ payout từng kênh ({input.channels.map((c) => `${c.channel} ${c.payoutEveryDays} ngày`).join(", ") || "chưa có kênh nào có doanh thu"}).
        Giá vốn: NCC trả trước trừ ngay, NCC công nợ lùi theo số ngày nợ. Chi phí định kỳ: ngân sách hạng mục có ngày đến hạn
        {payrollCost > 0n ? `; lương lấy từ kỳ lương gần nhất (${formatMoney(payrollCost)})` : ""}. Tiền bị giam chỉ cộng vào tuần dự kiến về.{pendingOrders > 0 && ` Đơn chờ về: ${pendingOrders} đơn đã bán chưa nằm trong payout, xếp theo lịch payout thật từng sàn (doanh thu trung bình của kênh đó chỉ tính cho đơn bán sau hôm nay).`}{filings > 0 && ` Gồm ${filings} nghĩa vụ pháp nhân còn mở (màn 16).`}
      </p>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* Khoản dự kiến nhập tay */}
        <section className="card p-5">
          <h2 className="font-bold">Khoản dự kiến (thuế, khoản bất thường…)</h2>
          <form action={addItem.bind(null, qs)} className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field name="label" label="Nội dung" required placeholder="Nộp thuế quý 4" />
            <Field name="expectedOn" label="Ngày dự kiến" type="date" required defaultValue={bizDateStr(today)} />
            <Field name="direction" label="Thu / chi" required empty={false} defaultValue="OUT" options={[{ value: "OUT", label: "Chi" }, { value: "IN", label: "Thu" }]} />
            <Field name="amount" label="Số tiền (đ)" required inputMode="numeric" />
            <Field name="confidence" label="Độ chắc chắn (%)" type="number" min={1} max={100} defaultValue="100" help="Chỉ áp cho khoản thu; khoản chi luôn tính đủ" />
            <Field name="recurring" label="Lặp lại" options={[{ value: "MONTHLY", label: "Hằng tháng" }, { value: "WEEKLY", label: "Hằng tuần" }]} empty="Không" />
            <div><button className="btn-primary" type="submit">Thêm</button></div>
          </form>
          <ul className="mt-4 divide-y divide-hair text-sm">
            {items.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <Badge tone={i.direction === "OUT" ? "crit" : "good"}>{i.direction === "OUT" ? "Chi" : "Thu"}</Badge>{" "}
                  {i.label} · {fmtBizDate(i.expectedOn)}{i.recurring ? ` · ${i.recurring === "MONTHLY" ? "hằng tháng" : "hằng tuần"}` : ""}
                  {i.direction === "IN" && i.confidence < 100 ? ` · ${i.confidence}%` : ""}
                </span>
                <span className="flex items-center gap-3">
                  <span className="tabular-nums">{formatMoney(i.amountVnd)}</span>
                  <form action={removeItem.bind(null, qs, i.id)}><button className="text-xs text-crit hover:underline" type="submit">Bỏ</button></form>
                </span>
              </li>
            ))}
            {!items.length && <li className="py-2 text-muted">Chưa có khoản nào.</li>}
          </ul>
        </section>

        {/* Lưu & độ lệch */}
        <section className="card p-5">
          <h2 className="font-bold">Lưu dự báo & độ lệch</h2>
          <p className="mt-1 text-sm text-ink-2">Lưu dự báo mỗi tuần. Sau vài tuần, bảng dưới cho biết dự báo lệch thực tế bao nhiêu để chỉnh hệ số.</p>
          <form action={saveSnapshot.bind(null, qs)} className="mt-3">
            <input type="hidden" name="name" value={input.scenario.name} />
            <input type="hidden" name="rf" value={input.scenario.revenueFactor} />
            <input type="hidden" name="ff" value={input.scenario.ffRate} />
            <input type="hidden" name="floor" value={floor.toString()} />
            <button className="btn" type="submit">Lưu dự báo tuần {ddmm(start)} (kịch bản đang xem)</button>
          </form>
          <table className="tbl mt-4 text-xs">
            <thead><tr><th>Lưu ngày</th><th>Tuần</th><th className="text-right">Dự báo</th><th className="text-right">Thực tế</th><th className="text-right">Lệch</th></tr></thead>
            <tbody>
              {accuracy.map((a, i) => {
                const diff = a.real! - a.predicted;
                const pct = a.real ? Math.round((Number(diff) / Math.max(1, Math.abs(Number(a.real)))) * 1000) / 10 : 0;
                return (
                  <tr key={i}>
                    <td>{fmtBizDate(a.snap.createdAt)}</td>
                    <td>T{a.week} · đến {a.to.split("-").reverse().join("/").slice(0, 5)}</td>
                    <td className="text-right tabular-nums">{compactVnd(Number(a.predicted))}</td>
                    <td className="text-right tabular-nums">{compactVnd(Number(a.real))}</td>
                    <td className={`text-right tabular-nums ${Math.abs(pct) > 10 ? "text-crit" : ""}`}>{pct > 0 ? "+" : ""}{pct.toLocaleString("vi-VN")}%</td>
                  </tr>
                );
              })}
              {!accuracy.length && <tr><td colSpan={5} className="py-4 text-center text-muted">{snapshots.length ? "Chưa có tuần nào đã qua để so." : "Chưa lưu dự báo nào."}</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
