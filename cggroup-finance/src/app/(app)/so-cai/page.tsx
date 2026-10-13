import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { bizDateStr, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { balanceSheet, trialBalance } from "@/lib/gl";
import { loadGlLines, monthRange } from "@/lib/gl-data";
import { lockedAccounts, MANUAL_ROWS, SOURCE_VI } from "@/lib/manual-journal";
import { formatMoney } from "@/lib/money";
import { Badge, Flash, PageHead } from "../ui";
import { postManualAction, reverseManualAction } from "./actions";

type SP = { tab?: string; thang?: string; tk?: string; nguon?: string; trang?: string; ok?: string; error?: string };
const PAGE = 40;
const TYPE_VI: Record<string, string> = { ASSET: "Tài sản", LIABILITY: "Nợ phải trả", EQUITY: "Vốn", REVENUE: "Doanh thu", COGS: "Giá vốn", EXPENSE: "Chi phí", OTHER: "Khác" };
const v = (x: bigint) => (x === 0n ? "" : formatMoney(x));

/** Màn 24 — sổ cái: bút toán bấm xuống tới chứng từ gốc và người nhập; cân đối thử; bảng cân đối; bút toán điều chỉnh. */
export default async function GeneralLedgerPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireUser(["ADMIN", "KE_TOAN", "QUAN_LY"]);
  const sp = await searchParams;
  const today = todayVn();
  const thang = /^\d{4}-\d{2}$/.test(sp.thang ?? "") ? sp.thang! : bizDateStr(today).slice(0, 7);
  const [y, m] = thang.split("-").map(Number);
  const { from, to } = monthRange(y, m);
  const tab = sp.tab === "can-doi-thu" || sp.tab === "can-doi" ? sp.tab : "but-toan";
  const keep = new URLSearchParams();
  for (const k of ["tab", "thang", "tk", "nguon", "trang"] as const) if (sp[k]) keep.set(k, sp[k]!);
  const qs = keep.toString();
  const link = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams(keep);
    for (const [k, val] of Object.entries(patch)) {
      if (val === null) u.delete(k);
      else u.set(k, val);
    }
    return `/so-cai?${u}`;
  };
  const canWrite = me.role === "ADMIN" || me.role === "KE_TOAN";

  const [accounts, shops, users, closing] = await Promise.all([
    prisma.account.findMany({ orderBy: { code: "asc" } }),
    prisma.shop.findMany({ select: { id: true, code: true }, orderBy: { code: "asc" } }),
    prisma.user.findMany({ select: { id: true, name: true } }),
    prisma.periodClosing.findUnique({ where: { year_month: { year: y, month: m } } }),
  ]);
  const shopCode = new Map(shops.map((s) => [s.id, s.code]));
  const userName = new Map(users.map((u) => [u.id, u.name]));

  return (
    <div className="max-w-7xl">
      <PageHead no={24} title="Sổ cái">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value={tab} />
          <div><label className="label" htmlFor="thang">Tháng</label><input className="input" id="thang" name="thang" type="month" defaultValue={thang} /></div>
          {tab === "but-toan" && (
            <>
              <div>
                <label className="label" htmlFor="tk">Tài khoản</label>
                <select className="input" id="tk" name="tk" defaultValue={sp.tk ?? ""}>
                  <option value="">Tất cả</option>
                  {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="nguon">Nguồn</label>
                <select className="input" id="nguon" name="nguon" defaultValue={sp.nguon ?? ""}>
                  <option value="">Tất cả</option>
                  {Object.entries(SOURCE_VI).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            </>
          )}
          <button className="btn" type="submit">Xem</button>
        </form>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        {[["but-toan", "Bút toán"], ["can-doi-thu", "Cân đối thử"], ["can-doi", "Bảng cân đối"]].map(([k, l]) => (
          <Link key={k} href={link({ tab: k, trang: null })} className={`rounded-md px-3 py-1.5 ${tab === k ? "bg-accent text-white" : "bg-surface hover:bg-page"}`}>{l}</Link>
        ))}
        {closing?.status === "CLOSED" && <Badge tone="good">Kỳ {m}/{y} đã đóng sổ</Badge>}
      </div>

      {tab === "but-toan" && <Entries />}
      {tab === "can-doi-thu" && <Trial />}
      {tab === "can-doi" && <Balance />}
    </div>
  );

  async function Entries() {
    const where: Prisma.JournalEntryWhereInput = {
      date: { gte: from, lte: to },
      ...(sp.tk ? { lines: { some: { accountCode: sp.tk } } } : {}),
      ...(sp.nguon ? { source: sp.nguon } : {}),
    };
    const page = Math.max(1, Number(sp.trang) || 1);
    const [count, entries] = await Promise.all([
      prisma.journalEntry.count({ where }),
      prisma.journalEntry.findMany({
        where,
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: { lines: { include: { account: true } }, cashTxn: { select: { accountId: true, voidedAt: true } } },
      }),
    ]);
    const ids = entries.map((e) => e.id);
    const [reversed, bills, periods, allocs, ars] = await Promise.all([
      prisma.journalEntry.findMany({ where: { reversalOf: { in: ids } }, select: { reversalOf: true } }),
      prisma.supplierBill.findMany({ where: { journalId: { in: ids } }, select: { journalId: true } }),
      prisma.payrollPeriod.findMany({ where: { journalId: { in: ids } }, select: { id: true, journalId: true } }),
      prisma.allocationRun.findMany({ where: { journalId: { in: ids } }, select: { journalId: true, year: true, month: true } }),
      prisma.arInvoice.findMany({ where: { journalId: { in: ids } }, select: { journalId: true } }),
    ]);
    const reversedSet = new Set(reversed.map((r) => r.reversalOf));
    const periodOf = new Map(periods.map((p) => [p.journalId, p.id]));
    const billSet = new Set(bills.map((b) => b.journalId));
    const allocOf = new Map(allocs.map((a) => [a.journalId, a]));
    const arSet = new Set(ars.map((a) => a.journalId));
    const sourceHref = (e: (typeof entries)[number]): string | null => {
      if (e.cashTxn) return `/so-quy?acc=${e.cashTxn.accountId}&from=${bizDateStr(e.date)}&to=${bizDateStr(e.date)}${e.cashTxn.voidedAt ? "&voided=1" : ""}`;
      if (billSet.has(e.id)) return "/cong-no";
      if (periodOf.has(e.id)) return `/ky-luong/${periodOf.get(e.id)}`;
      if (allocOf.has(e.id)) return `/phan-bo?thang=${thang}`;
      if (arSet.has(e.id)) return "/cong-no?tab=phai-thu";
      if (e.source === "EXPENSE") return "/chi-phi";
      if (e.source === "CLOSING") return `/dong-so?thang=${thang}`;
      return null;
    };
    const pages = Math.max(1, Math.ceil(count / PAGE));
    const locked = canWrite ? await lockedAccounts(prisma) : new Set<string>();

    return (
      <>
        <div className="mt-4 space-y-3">
          {entries.map((e) => {
            const href = sourceHref(e);
            const total = e.lines.reduce((a, l) => a + l.debitVnd, 0n);
            return (
              <div key={e.id} className="card overflow-x-auto p-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <span className="font-semibold tabular-nums">{fmtBizDate(e.date)}</span>
                  <Badge tone={e.source === "MANUAL" ? "accent" : "muted"}>{SOURCE_VI[e.source] ?? e.source}</Badge>
                  <span className="min-w-0 flex-1">{e.memo}</span>
                  {e.reversalOf && <Badge tone="crit">bút toán đảo</Badge>}
                  {reversedSet.has(e.id) && <Badge tone="crit">đã bị đảo</Badge>}
                  <span className="text-xs text-muted">
                    {userName.get(e.createdBy) ?? e.createdBy} · {e.createdAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}
                  </span>
                  {href && <Link className="text-xs text-accent hover:underline" href={href}>Chứng từ gốc →</Link>}
                </div>
                <table className="tbl mt-2 text-sm">
                  <tbody>
                    {e.lines.map((l) => (
                      <tr key={l.id} className={sp.tk === l.accountCode ? "bg-accent/5" : ""}>
                        <td className={`w-2/5 ${l.creditVnd > 0n ? "pl-8" : ""}`}>
                          <span className="font-mono text-xs">{l.accountCode}</span> {l.account.name}
                          {l.shopId && <span className="text-xs text-muted"> · {shopCode.get(l.shopId)}</span>}
                        </td>
                        <td className="text-right tabular-nums">{v(l.debitVnd)}</td>
                        <td className="text-right tabular-nums">{v(l.creditVnd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {canWrite && e.source === "MANUAL" && !e.reversalOf && !reversedSet.has(e.id) && (
                  <form action={reverseManualAction.bind(null, qs, e.id)} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                    <input className="input max-w-xs" name="reason" placeholder="Lý do đảo" />
                    <button className="btn" type="submit">Đảo bút toán</button>
                    <span className="text-xs text-muted">tổng {formatMoney(total)}</span>
                  </form>
                )}
              </div>
            );
          })}
          {!entries.length && <p className="card p-6 text-center text-sm text-muted">Không có bút toán nào trong {m}/{y} với bộ lọc này.</p>}
        </div>
        {pages > 1 && (
          <div className="mt-3 flex items-center gap-3 text-sm">
            {page > 1 && <Link className="text-accent hover:underline" href={link({ trang: String(page - 1) })}>← Trước</Link>}
            <span className="text-muted">Trang {page}/{pages} · {count} bút toán</span>
            {page < pages && <Link className="text-accent hover:underline" href={link({ trang: String(page + 1) })}>Sau →</Link>}
          </div>
        )}

        {canWrite && (
          <section className="card mt-6 p-5">
            <h2 className="font-bold">Bút toán điều chỉnh</h2>
            <p className="mt-1 text-sm text-ink-2">
              Cho khấu hao, trích trước, phân loại lại chi phí… Nợ phải bằng Có. Không sửa, không xoá — sai thì đảo. Không ghi tay vào TK tiền, 131, 201, 302
              (có sổ chi tiết riêng: Sổ quỹ, Công nợ, Đóng sổ).
            </p>
            <form action={postManualAction.bind(null, qs)} className="mt-3 space-y-2">
              <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
                <div><label className="label" htmlFor="date">Ngày *</label><input className="input" id="date" name="date" type="date" required defaultValue={bizDateStr(today)} /></div>
                <div><label className="label" htmlFor="memo">Diễn giải *</label><input className="input" id="memo" name="memo" required placeholder="VD: Khấu hao máy tính tháng 10" /></div>
              </div>
              <div className="overflow-x-auto">
                <table className="tbl text-sm">
                  <thead><tr><th>Tài khoản</th><th>Shop</th><th className="text-right">Nợ</th><th className="text-right">Có</th></tr></thead>
                  <tbody>
                    {Array.from({ length: MANUAL_ROWS }, (_, i) => (
                      <tr key={i}>
                        <td>
                          <select className="input min-w-48" name={`acc${i}`} aria-label={`Tài khoản dòng ${i + 1}`} defaultValue="">
                            <option value="">—</option>
                            {accounts.filter((a) => !locked.has(a.code)).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                          </select>
                        </td>
                        <td>
                          <select className="input" name={`shop${i}`} aria-label={`Shop dòng ${i + 1}`} defaultValue="">
                            <option value="">—</option>
                            {shops.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                          </select>
                        </td>
                        <td><input className="input text-right" name={`dr${i}`} inputMode="numeric" aria-label={`Nợ dòng ${i + 1}`} /></td>
                        <td><input className="input text-right" name={`cr${i}`} inputMode="numeric" aria-label={`Có dòng ${i + 1}`} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="btn btn-primary" type="submit">Ghi bút toán</button>
            </form>
          </section>
        )}
      </>
    );
  }

  async function Trial() {
    const tb = trialBalance(await loadGlLines(prisma, { to }));
    const mov = trialBalance(await loadGlLines(prisma, { from, to }));
    const movOf = new Map(mov.rows.map((r) => [r.accountCode, r]));
    return (
      <section className="card mt-4 overflow-x-auto p-5">
        <h2 className="font-bold">Bảng cân đối thử đến {fmtBizDate(to)}</h2>
        <p className="mt-1 text-sm text-ink-2">
          Phát sinh trong tháng {m}/{y} và số dư luỹ kế. Tổng nợ = tổng có:{" "}
          {tb.balanced ? <strong className="text-good">cân</strong> : <strong className="text-crit">lệch {formatMoney(tb.diffVnd)}</strong>}.
        </p>
        <table className="tbl mt-3 text-sm">
          <thead>
            <tr><th>TK</th><th>Tên</th><th>Loại</th><th className="text-right">PS nợ</th><th className="text-right">PS có</th><th className="text-right">Nợ luỹ kế</th><th className="text-right">Có luỹ kế</th><th className="text-right">Số dư</th></tr>
          </thead>
          <tbody>
            {tb.rows.map((r) => (
              <tr key={r.accountCode}>
                <td className="font-mono text-xs"><Link className="text-accent hover:underline" href={link({ tab: "but-toan", tk: r.accountCode, trang: null })}>{r.accountCode}</Link></td>
                <td>{r.accountName}</td>
                <td className="text-xs text-muted">{TYPE_VI[r.accountType]}</td>
                <td className="text-right tabular-nums">{v(movOf.get(r.accountCode)?.debitVnd ?? 0n)}</td>
                <td className="text-right tabular-nums">{v(movOf.get(r.accountCode)?.creditVnd ?? 0n)}</td>
                <td className="text-right tabular-nums">{v(r.debitVnd)}</td>
                <td className="text-right tabular-nums">{v(r.creditVnd)}</td>
                <td className={`text-right font-semibold tabular-nums ${r.balanceVnd < 0n ? "text-crit" : ""}`}>{formatMoney(r.balanceVnd)}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td colSpan={3}>Tổng</td>
              <td className="text-right tabular-nums">{formatMoney(mov.totalDebitVnd)}</td>
              <td className="text-right tabular-nums">{formatMoney(mov.totalCreditVnd)}</td>
              <td className="text-right tabular-nums">{formatMoney(tb.totalDebitVnd)}</td>
              <td className="text-right tabular-nums">{formatMoney(tb.totalCreditVnd)}</td>
              <td />
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">Số dư theo chiều tự nhiên: tài sản, giá vốn, chi phí dương bên nợ; còn lại dương bên có. Số âm (đỏ) là bất thường.</p>
      </section>
    );
  }

  async function Balance() {
    const lines = await loadGlLines(prisma, { to });
    const bs = balanceSheet(lines);
    const tb = trialBalance(lines);
    const group = (t: string) => tb.rows.filter((r) => r.accountType === t && r.balanceVnd !== 0n);
    const Block = ({ title, type, extra }: { title: string; type: string; extra?: React.ReactNode }) => (
      <div>
        <h3 className="font-semibold">{title}</h3>
        <table className="tbl mt-1 text-sm">
          <tbody>
            {group(type).map((r) => (
              <tr key={r.accountCode}><td><span className="font-mono text-xs">{r.accountCode}</span> {r.accountName}</td><td className="text-right tabular-nums">{formatMoney(r.balanceVnd)}</td></tr>
            ))}
            {extra}
          </tbody>
        </table>
      </div>
    );
    return (
      <section className="card mt-4 p-5">
        <h2 className="font-bold">Bảng cân đối kế toán tại {fmtBizDate(to)}</h2>
        <p className="mt-1 text-sm text-ink-2">
          Tài sản {formatMoney(bs.assetsVnd)} = Nợ phải trả {formatMoney(bs.liabilitiesVnd)} + Vốn {formatMoney(bs.equityVnd)} + Lãi lỗ chưa kết chuyển{" "}
          {formatMoney(bs.retainedThisPeriodVnd)} →{" "}
          {bs.balanced ? <strong className="text-good">cân</strong> : <strong className="text-crit">lệch {formatMoney(bs.diffVnd)}</strong>}
        </p>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <Block title={`Tài sản — ${formatMoney(bs.assetsVnd)}`} type="ASSET" />
          <div className="space-y-4">
            <Block title={`Nợ phải trả — ${formatMoney(bs.liabilitiesVnd)}`} type="LIABILITY" />
            <Block
              title={`Vốn chủ sở hữu — ${formatMoney(bs.equityVnd + bs.retainedThisPeriodVnd)}`}
              type="EQUITY"
              extra={<tr><td>Lãi lỗ các kỳ chưa đóng sổ</td><td className="text-right tabular-nums">{formatMoney(bs.retainedThisPeriodVnd)}</td></tr>}
            />
          </div>
        </div>
        <p className="mt-3 text-xs text-muted">Số dư TK tiền là sổ quỹ quy VND theo tỷ giá ngày giao dịch (giá gốc), không đánh giá lại theo tỷ giá cuối kỳ.</p>
      </section>
    );
  }
}
