import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { closingStatus } from "@/lib/closing-service";
import { addDays, fmtBizDate, startOfWeek, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { buildForecast } from "@/lib/forecast";
import { loadForecastInput } from "@/lib/forecast-data";
import { profitAndLoss } from "@/lib/gl";
import { loadGlLines, monthRange, prevMonth } from "@/lib/gl-data";
import { formatMoney, toVnd, type Currency } from "@/lib/money";
import { bookBalance, compactVnd, type LedgerTxn } from "@/lib/overview";
import type { Role } from "@/lib/permissions";
import { pnlByDimension, UNASSIGNED } from "@/lib/pnl-dims";
import { Badge, PageHead } from "../ui";

type View = "giam-doc" | "ke-toan" | "truong-team" | "nhan-vien";
const VIEW_VI: Record<View, string> = { "giam-doc": "Giám đốc", "ke-toan": "Kế toán", "truong-team": "Trưởng team", "nhan-vien": "Nhân viên" };
const LEVEL_TONE = { ERROR: "crit", WARN: "accent", INFO: "muted" } as const;

function Kpi({ label, value, sub, bad, href }: { label: string; value: string; sub?: string; bad?: boolean; href?: string }) {
  const body = (
    <>
      <div className="text-xs text-ink-2">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${bad ? "text-crit" : ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </>
  );
  return href ? <Link href={href} className={`card block p-4 hover:shadow-sm ${bad ? "border-crit/40" : ""}`}>{body}</Link> : <div className={`card p-4 ${bad ? "border-crit/40" : ""}`}>{body}</div>;
}

/** Màn 29 — mỗi vai trò một bảng điều khiển; Admin xem được tất cả. */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ vai?: string }> }) {
  const me = await requireUser();
  const sp = await searchParams;
  const emp = await prisma.employee.findUnique({ where: { userId: me.uid }, include: { department: true, _count: { select: { reports: true } } } });
  const isLead = (emp?._count.reports ?? 0) > 0;
  const allowed: View[] = (
    {
      ADMIN: ["giam-doc", "ke-toan", "truong-team", "nhan-vien"],
      QUAN_LY: ["giam-doc", "truong-team", "nhan-vien"],
      KE_TOAN: ["ke-toan", "nhan-vien"],
      NHAN_VIEN: isLead ? ["truong-team", "nhan-vien"] : ["nhan-vien"],
    } as Record<Role, View[]>
  )[me.role];
  const view = allowed.includes(sp.vai as View) ? (sp.vai as View) : allowed[0];

  return (
    <div className="max-w-7xl">
      <PageHead no={29} title={`Chào ${me.name}`}>
        {allowed.length > 1 && (
          <div className="flex flex-wrap gap-2 text-sm">
            {allowed.map((v) => (
              <Link key={v} href={`/bang-dieu-khien?vai=${v}`} className={`rounded-md px-3 py-1.5 ${v === view ? "bg-accent text-white" : "bg-surface hover:bg-page"}`}>{VIEW_VI[v]}</Link>
            ))}
          </div>
        )}
      </PageHead>
      {view === "giam-doc" && <Director />}
      {view === "ke-toan" && <Accountant />}
      {view === "truong-team" && <TeamLead deptId={emp?.departmentId ?? null} deptName={emp?.department?.name ?? null} />}
      {view === "nhan-vien" && <Employee employeeId={emp?.id ?? null} uid={me.uid} />}
    </div>
  );
}

async function Director() {
  const today = todayVn();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const pm = prevMonth(y, m);
  const [accounts, txns, rate, cur, prev, alerts, shops, fc] = await Promise.all([
    prisma.cashAccount.findMany({ where: { active: true } }),
    prisma.cashTxn.findMany({ where: { voidedAt: null }, select: { accountId: true, date: true, direction: true, amount: true, currency: true } }),
    prisma.fxRate.findFirst({ where: { base: "USD", quote: "VND" }, orderBy: { date: "desc" } }),
    loadGlLines(prisma, { ...monthRange(y, m), excludeClosing: true }),
    loadGlLines(prisma, { ...monthRange(pm.year, pm.month), excludeClosing: true }),
    prisma.alertLog.findMany({ where: { resolvedAt: null }, orderBy: [{ level: "desc" }, { firedAt: "asc" }] }),
    pnlByDimension(prisma, { year: pm.year, month: pm.month, dim: "shop" }),
    loadForecastInput(prisma, { startDate: startOfWeek(today) }),
  ]);
  const ledger: LedgerTxn[] = txns.map((t) => ({ ...t, currency: t.currency as Currency }));
  const cash = accounts.reduce((s, a) => {
    const b = bookBalance(ledger, a.id);
    return s + (a.currency === "VND" ? b : rate ? toVnd(b, a.currency as Currency, rate.rate) : 0n);
  }, 0n);
  const pc = profitAndLoss(cur);
  const pp = profitAndLoss(prev);
  const rows = buildForecast(fc.input);
  const low = rows.reduce((a, r) => (r.closing < a.closing ? r : a), rows[0]);
  const ranked = shops.columns.filter((c) => c.key !== UNASSIGNED && c.pnl.revenueVnd > 0n).sort((a, b) => Number(b.pnl.netProfitVnd - a.pnl.netProfitVnd));

  return (
    <>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Tiền khả dụng" value={compactVnd(Number(cash))} sub={rate ? `tỷ giá ${Number(rate.rate).toLocaleString("vi-VN")}` : "chưa có tỷ giá"} href="/tong-quan" />
        <Kpi label={`Lợi nhuận tháng ${m} (đến hôm nay)`} value={compactVnd(Number(pc.netProfitVnd))} sub={`doanh thu ${compactVnd(Number(pc.revenueVnd))}`} bad={pc.netProfitVnd < 0n} href={`/pnl?thang=${y}-${String(m).padStart(2, "0")}`} />
        <Kpi label={`Lợi nhuận tháng ${pm.month}`} value={compactVnd(Number(pp.netProfitVnd))} sub={pp.revenueVnd > 0n ? `biên ${(pp.netMarginPct * 100).toFixed(1)}%` : undefined} bad={pp.netProfitVnd < 0n} href="/pnl" />
        <Kpi label="Đáy dự báo 13 tuần" value={low ? compactVnd(Number(low.closing)) : "—"} sub={low ? `tuần ${low.week} (từ ${fmtBizDate(low.from)})` : undefined} bad={!!low && low.closing < 0n} href="/du-bao" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <div className="flex items-baseline justify-between"><h2 className="font-bold">Cảnh báo đang mở ({alerts.length})</h2><Link className="text-sm text-accent hover:underline" href="/canh-bao">Tất cả →</Link></div>
          <ul className="mt-2 space-y-2 text-sm">
            {alerts.slice(0, 6).map((a) => (
              <li key={a.id}><Badge tone={LEVEL_TONE[a.level]}>{a.level === "ERROR" ? "!" : a.level === "WARN" ? "⚠" : "i"}</Badge> {a.href ? <Link className="hover:text-accent" href={a.href}>{a.title}</Link> : a.title}</li>
            ))}
            {!alerts.length && <li className="text-good">✓ Không có cảnh báo nào.</li>}
          </ul>
        </section>
        <section className="card p-5">
          <h2 className="font-bold">Shop tháng {pm.month}/{pm.year} — lãi / lỗ</h2>
          <table className="tbl mt-2 text-sm">
            <tbody>
              {[...ranked.slice(0, 3), ...ranked.slice(3).slice(-3)].map((c) => (
                <tr key={c.key}><td>{c.label}</td><td className={`text-right tabular-nums ${c.pnl.netProfitVnd < 0n ? "text-crit" : ""}`}>{compactVnd(Number(c.pnl.netProfitVnd))}</td></tr>
              ))}
              {!ranked.length && <tr><td className="text-muted">Chưa có doanh thu theo shop.</td></tr>}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">Sau phân bổ chi phí chung (màn 26). <Link className="text-accent hover:underline" href={`/pnl?thang=${pm.year}-${String(pm.month).padStart(2, "0")}&chieu=shop`}>P&L theo shop →</Link></p>
        </section>
      </div>
    </>
  );
}

async function Accountant() {
  const today = todayVn();
  const pm = prevMonth(today.getUTCFullYear(), today.getUTCMonth() + 1);
  const [st, drafts, billsSoon, unrec, arLate, taxSoon] = await Promise.all([
    prisma.$transaction((tx) => closingStatus(tx, pm.year, pm.month), { timeout: 30_000 }),
    prisma.expense.count({ where: { status: "DRAFT" } }),
    prisma.supplierBill.findMany({ where: { status: { not: "PAID" }, dueDate: { lte: addDays(today, 7) } }, select: { amountVnd: true, paidVnd: true } }),
    prisma.payout.count({ where: { reconciled: false } }),
    prisma.arInvoice.findMany({ where: { status: { not: "PAID" }, dueDate: { lt: today } }, select: { amountVnd: true, paidVnd: true } }),
    prisma.taxObligation.findMany({ where: { status: { not: "PAID" }, dueDate: { lte: addDays(today, 7) } }, select: { amountVnd: true, paidVnd: true } }),
  ]);
  const sum = (xs: { amountVnd: bigint; paidVnd: bigint }[]) => xs.reduce((a, x) => a + x.amountVnd - x.paidVnd, 0n);
  const closed = st.closing?.status === "CLOSED";
  const thang = `${pm.year}-${String(pm.month).padStart(2, "0")}`;
  return (
    <>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Kpi label="Đề nghị chi chờ duyệt" value={String(drafts)} href="/chi-phi" />
        <Kpi label="Hoá đơn NCC đến hạn ≤ 7 ngày" value={formatMoney(sum(billsSoon))} sub={`${billsSoon.length} hoá đơn`} bad={billsSoon.length > 0} href="/cong-no?soon=1" />
        <Kpi label="Payout chưa khớp" value={String(unrec)} bad={unrec > 0} href="/doi-soat" />
        <Kpi label="Phải thu quá hạn" value={formatMoney(sum(arLate))} sub={`${arLate.length} khoản`} bad={arLate.length > 0} href="/cong-no?tab=phai-thu" />
        <Kpi label="Thuế đến hạn ≤ 7 ngày" value={formatMoney(sum(taxSoon))} sub={`${taxSoon.length} khoản`} bad={taxSoon.length > 0} href="/cong-no?tab=thue" />
        <Kpi label={`Đóng sổ tháng ${pm.month}/${pm.year}`} value={closed ? "Đã đóng" : `${st.steps.filter((s) => s.done).length}/${st.steps.length} bước`} bad={!closed && today.getUTCDate() > 10} href={`/dong-so?thang=${thang}`} />
      </div>
      {!closed && (
        <section className="card mt-4 p-5">
          <h2 className="font-bold">Việc còn lại để đóng sổ {pm.month}/{pm.year}</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {st.steps.filter((s) => !s.done).map((s) => (
              <li key={s.code}>
                {s.blocking ? "⛔" : "◻"} {s.href ? <Link className="hover:text-accent" href={s.href}>{s.title}</Link> : s.title}
                {s.detail && <span className="text-ink-2"> — {s.detail}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

async function TeamLead({ deptId, deptName }: { deptId: string | null; deptName: string | null }) {
  if (!deptId) return <p className="card mt-4 p-6 text-sm text-muted">Tài khoản chưa gắn với hồ sơ nhân sự có phòng ban (màn 9).</p>;
  const today = todayVn();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const pm = prevMonth(y, m);
  const [cur, prev, members, leaves, shops] = await Promise.all([
    pnlByDimension(prisma, { year: y, month: m, dim: "team" }),
    pnlByDimension(prisma, { year: pm.year, month: pm.month, dim: "team" }),
    prisma.employee.findMany({ where: { departmentId: deptId, leftAt: null }, orderBy: { code: "asc" } }),
    prisma.leaveRequest.findMany({ where: { status: "PENDING", employee: { departmentId: deptId } }, include: { employee: true } }),
    prisma.shop.findMany({ where: { status: { not: "CLOSED" } }, select: { code: true, status: true, ownerId: true } }),
  ]);
  const mine = cur.columns.find((c) => c.key === deptId);
  const before = prev.columns.find((c) => c.key === deptId);
  const userIds = new Set(members.map((e) => e.userId).filter(Boolean));
  const teamShops = shops.filter((s) => s.ownerId && userIds.has(s.ownerId));
  return (
    <>
      <h2 className="mt-4 font-bold">Team {deptName}</h2>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={`Doanh thu tháng ${m}`} value={compactVnd(Number(mine?.pnl.revenueVnd ?? 0n))} />
        <Kpi label={`Lợi nhuận tháng ${m}`} value={compactVnd(Number(mine?.pnl.netProfitVnd ?? 0n))} bad={(mine?.pnl.netProfitVnd ?? 0n) < 0n} />
        <Kpi label={`Lợi nhuận tháng ${pm.month}`} value={compactVnd(Number(before?.pnl.netProfitVnd ?? 0n))} bad={(before?.pnl.netProfitVnd ?? 0n) < 0n} />
        <Kpi label="Đơn nghỉ chờ duyệt" value={String(leaves.length)} href="/nghi-phep" bad={leaves.length > 0} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <h3 className="font-semibold">Thành viên ({members.length})</h3>
          <p className="mt-1 text-sm text-ink-2">{members.map((e) => e.fullName).join(", ") || "—"}</p>
        </section>
        <section className="card p-5">
          <h3 className="font-semibold">Shop của team ({teamShops.length})</h3>
          <p className="mt-1 text-sm">
            {teamShops.map((s) => <span key={s.code} className="mr-2 inline-block">{s.code} {s.status !== "ACTIVE" && <Badge tone="crit">{s.status}</Badge>}</span>)}
            {!teamShops.length && <span className="text-muted">Chưa có shop nào do người trong team phụ trách (màn 16).</span>}
          </p>
        </section>
      </div>
      <p className="mt-2 text-xs text-muted">Lợi nhuận team = shop do người trong team phụ trách, sau phân bổ chi phí chung (màn 26).</p>
    </>
  );
}

async function Employee({ employeeId, uid }: { employeeId: string | null; uid: string }) {
  const year = todayVn().getUTCFullYear();
  const [slip, balances, expenses] = await Promise.all([
    employeeId
      ? prisma.payrollLine.findFirst({
          where: { employeeId, period: { status: { in: ["APPROVED", "PAID", "CLOSED"] } } },
          orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }],
          include: { period: true },
        })
      : null,
    employeeId ? prisma.leaveBalance.findMany({ where: { employeeId, year }, include: { leaveType: true } }) : [],
    prisma.expense.findMany({ where: { requestedBy: uid }, orderBy: { date: "desc" }, take: 5, include: { category: true } }),
  ]);
  const EXP = { DRAFT: "Chờ duyệt", APPROVED: "Đã duyệt", PAID: "Đã chi", REJECTED: "Từ chối" } as const;
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-3">
      <section className="card p-5">
        <h2 className="font-bold">Phiếu lương gần nhất</h2>
        {slip ? (
          <>
            <div className="mt-2 text-2xl font-bold tabular-nums">{formatMoney(slip.netVnd)}</div>
            <p className="text-sm text-ink-2">tháng {slip.period.month}/{slip.period.year} · {Number(slip.workedDays)} ngày công</p>
            <Link className="mt-2 inline-block text-sm text-accent hover:underline" href={`/phieu-luong?ky=${slip.periodId}`}>Xem phiếu lương →</Link>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">{employeeId ? "Chưa có kỳ lương đã duyệt." : "Tài khoản chưa gắn hồ sơ nhân sự."}</p>
        )}
      </section>
      <section className="card p-5">
        <h2 className="font-bold">Phép năm {year}</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {balances.map((b) => (
            <li key={b.id} className="flex justify-between"><span>{b.leaveType.name}</span><span className="tabular-nums">còn {Number(b.entitled) - Number(b.used)} / {Number(b.entitled)} ngày</span></li>
          ))}
          {!balances.length && <li className="text-muted">Chưa có số phép.</li>}
        </ul>
        <Link className="mt-2 inline-block text-sm text-accent hover:underline" href="/nghi-phep">Xin nghỉ →</Link>
      </section>
      <section className="card p-5">
        <h2 className="font-bold">Đề nghị chi của tôi</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {expenses.map((e) => (
            <li key={e.id} className="flex justify-between gap-2">
              <span className="truncate">{e.description}</span>
              <Badge tone={e.status === "REJECTED" ? "crit" : e.status === "PAID" ? "good" : "muted"}>{EXP[e.status]}</Badge>
            </li>
          ))}
          {!expenses.length && <li className="text-muted">Chưa có.</li>}
        </ul>
        <Link className="mt-2 inline-block text-sm text-accent hover:underline" href="/chi-phi">Tạo đề nghị chi →</Link>
      </section>
    </div>
  );
}
