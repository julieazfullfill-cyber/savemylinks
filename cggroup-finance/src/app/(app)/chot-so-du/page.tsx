import { requireUser } from "@/lib/auth";
import { closingDiff } from "@/lib/closing";
import { bizDateStr, fmtBizDate, parseBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney, MINOR_DIGITS, type Currency } from "@/lib/money";
import { bookBalance, type LedgerTxn } from "@/lib/overview";
import { Badge, Flash, PageHead } from "../ui";
import { saveClosing } from "./actions";

/** minor unit → chuỗi để điền lại vào ô nhập (đô có 2 số lẻ, đồng không). */
function toInput(v: bigint, cur: Currency): string {
  const d = MINOR_DIGITS[cur];
  if (!d) return v.toString();
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(d);
  return `${neg ? "-" : ""}${a / base},${(a % base).toString().padStart(d, "0")}`;
}

function DiffBadge({ diff, cur }: { diff: bigint; cur: Currency }) {
  return diff === 0n ? <Badge tone="good">✓ Khớp</Badge> : <Badge tone="crit">⚠ Lệch {formatMoney(diff, cur)}</Badge>;
}

export default async function ClosingPage({ searchParams }: { searchParams: Promise<{ date?: string; ok?: string; error?: string }> }) {
  await requireUser(["ADMIN", "KE_TOAN"]);
  const sp = await searchParams;
  let date = todayVn();
  try {
    if (sp.date) date = parseBizDate(sp.date);
  } catch {}

  const [accounts, txns, closesOnDate, history] = await Promise.all([
    prisma.cashAccount.findMany({ where: { active: true }, include: { provider: true }, orderBy: [{ provider: { name: "asc" } }, { code: "asc" }] }),
    prisma.cashTxn.findMany({ where: { voidedAt: null }, select: { accountId: true, date: true, direction: true, amount: true, currency: true } }),
    prisma.accountBalance.findMany({ where: { date } }),
    prisma.accountBalance.findMany({ include: { account: true }, orderBy: [{ date: "desc" }, { account: { code: "asc" } }], take: 60 }),
  ]);
  const ledger: LedgerTxn[] = txns.map((t) => ({ ...t, currency: t.currency as Currency }));
  const closeBy = new Map(closesOnDate.map((c) => [c.accountId, c]));

  return (
    <div className="max-w-7xl">
      <PageHead no={5} title="Chốt số dư">
        <form method="get" className="flex items-end gap-2">
          <div>
            <label className="label" htmlFor="pick">Ngày chốt</label>
            <input className="input" id="pick" name="date" type="date" defaultValue={bizDateStr(date)} />
          </div>
          <button className="btn" type="submit">Xem</button>
        </form>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <p className="mt-3 max-w-3xl text-sm text-ink-2">
        Cuối ngày, nhập số dư <strong>thật</strong> xem trên ngân hàng / ví / sàn. Hệ thống so với số dư tính từ Sổ quỹ và báo lệch.
        Phần <strong>bị giam</strong> trên sàn ghi riêng kèm ngày dự kiến về — nó không tính vào tiền khả dụng, dự báo chỉ cộng vào tuần tiền về.
      </p>

      <form action={saveClosing} className="card mt-4 overflow-x-auto">
        <input type="hidden" name="date" value={bizDateStr(date)} />
        <table className="tbl">
          <thead>
            <tr>
              <th>Tài khoản</th>
              <th className="text-right">Sổ quỹ {fmtBizDate(date)}</th>
              <th>Khả dụng thật</th>
              <th>Bị giam</th>
              <th>Ngày về</th>
              <th>Ghi chú</th>
              <th>So khớp</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const cur = a.currency as Currency;
              const book = bookBalance(ledger, a.id, date);
              const c = closeBy.get(a.id);
              return (
                <tr key={a.id}>
                  <td className="whitespace-nowrap">
                    <div className="text-xs text-muted">{a.provider.name}</div>
                    {a.code} <span className="text-xs text-muted">{a.email ?? a.name} · {cur}</span>
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">{formatMoney(book, cur)}</td>
                  <td><input className="input w-36" name={`avail_${a.id}`} inputMode="decimal" defaultValue={c ? toInput(c.available, cur) : ""} placeholder={toInput(book, cur)} aria-label={`Khả dụng ${a.code}`} /></td>
                  <td><input className="input w-28" name={`res_${a.id}`} inputMode="decimal" defaultValue={c && c.reserved ? toInput(c.reserved, cur) : ""} aria-label={`Bị giam ${a.code}`} /></td>
                  <td><input className="input w-36" name={`rel_${a.id}`} type="date" defaultValue={c?.releaseOn ? bizDateStr(c.releaseOn) : ""} aria-label={`Ngày về ${a.code}`} /></td>
                  <td><input className="input w-40" name={`note_${a.id}`} defaultValue={c?.note ?? ""} aria-label={`Ghi chú ${a.code}`} /></td>
                  <td className="whitespace-nowrap">{c ? <DiffBadge diff={closingDiff(c.available, book)} cur={cur} /> : <span className="text-xs text-muted">chưa chốt</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex items-center gap-3 border-t border-hair p-4">
          <button className="btn-primary" type="submit">Lưu chốt ngày {fmtBizDate(date)}</button>
          <span className="text-xs text-muted">Ô trống = không chốt tài khoản đó. Chốt lại cùng ngày sẽ ghi đè (có lưu lịch sử thay đổi).</span>
        </div>
      </form>

      <section className="mt-6">
        <h2 className="font-bold">Các lần chốt gần đây</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr><th>Ngày</th><th>Tài khoản</th><th className="text-right">Khả dụng</th><th className="text-right">Bị giam</th><th>Ngày về</th><th>So với sổ quỹ</th></tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const cur = h.account.currency as Currency;
                return (
                  <tr key={h.id}>
                    <td className="tabular-nums"><a className="text-accent hover:underline" href={`/chot-so-du?date=${bizDateStr(h.date)}`}>{fmtBizDate(h.date)}</a></td>
                    <td>{h.account.code}</td>
                    <td className="text-right tabular-nums">{formatMoney(h.available, cur)}</td>
                    <td className="text-right tabular-nums">{h.reserved ? formatMoney(h.reserved, cur) : <span className="text-muted">—</span>}</td>
                    <td className="tabular-nums">{h.releaseOn ? fmtBizDate(h.releaseOn) : ""}</td>
                    <td><DiffBadge diff={closingDiff(h.available, bookBalance(ledger, h.accountId, h.date))} cur={cur} /></td>
                  </tr>
                );
              })}
              {!history.length && <tr><td colSpan={6} className="py-6 text-center text-muted">Chưa chốt lần nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
