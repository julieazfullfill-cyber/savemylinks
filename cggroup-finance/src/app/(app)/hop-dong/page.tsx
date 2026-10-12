import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { STATUS_LABEL } from "@/lib/hr-forms";
import { formatMoney } from "@/lib/money";
import { salaryAt } from "@/lib/payroll-service";
import { Badge, PageHead } from "../ui";

/** Màn hình 10 — bảng lương theo hợp đồng tại một tháng bất kỳ. */
export default async function ContractsPage({ searchParams }: { searchParams: Promise<{ thang?: string }> }) {
  await requireUser(["ADMIN", "QUAN_LY"]);
  const { thang } = await searchParams;
  const today = todayVn();
  const m = /^(\d{4})-(\d{2})$/.exec(thang ?? "");
  const year = m ? +m[1] : today.getUTCFullYear();
  const month = m ? +m[2] : today.getUTCMonth() + 1;
  const ym = `${year}-${String(month).padStart(2, "0")}`;

  const rows = await prisma.$transaction((tx) => salaryAt(tx, year, month));
  const missing = rows.filter((r) => !r.contract).length;
  const total = rows.reduce(
    (a, r) => a + (r.contract ? r.contract.baseSalaryVnd + r.contract.allowanceVnd + r.contract.mealVnd + r.contract.transportVnd + r.contract.dutyVnd : 0n),
    0n,
  );

  return (
    <div className="max-w-6xl">
      <PageHead no={10} title="Hợp đồng & lương">
        <form method="get" className="flex items-end gap-2">
          <div>
            <label className="label" htmlFor="thang">Lương tại tháng</label>
            <input className="input" id="thang" name="thang" type="month" defaultValue={ym} />
          </div>
          <button className="btn" type="submit">Xem</button>
        </form>
      </PageHead>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="card p-4"><div className="text-xs text-muted">Nhân sự trong tháng</div><div className="text-xl font-bold tabular-nums">{rows.length}</div></div>
        <div className="card p-4"><div className="text-xs text-muted">Tổng lương cứng + phụ cấp theo hợp đồng</div><div className="text-xl font-bold tabular-nums">{formatMoney(total)}</div></div>
        <div className={`card p-4 ${missing ? "border-crit" : ""}`}>
          <div className="text-xs text-muted">Thiếu hợp đồng</div>
          <div className={`text-xl font-bold tabular-nums ${missing ? "text-crit" : ""}`}>{missing}</div>
          {missing > 0 && <div className="text-xs text-crit">Kỳ lương tháng này sẽ không tính được cho tới khi bổ sung.</div>}
        </div>
      </div>

      <div className="card mt-4 overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Mã</th><th>Họ tên</th><th>Phòng ban</th><th>Trạng thái</th><th>Hợp đồng từ</th>
              <th className="text-right">Lương cứng</th><th className="text-right">Phụ cấp (tổng)</th>
              <th className="text-right">Lương đóng BH</th><th className="text-right">NPT</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ employee: e, contract: c }) => (
              <tr key={e.id}>
                <td className="font-mono text-xs">{e.code}</td>
                <td><Link className="text-accent hover:underline" href={`/nhan-su/${e.id}#hop-dong`}>{e.fullName}</Link></td>
                <td>{e.department?.name ?? <span className="text-muted">—</span>}</td>
                <td>{STATUS_LABEL[e.status]}</td>
                {c ? (
                  <>
                    <td className="tabular-nums">{fmtBizDate(c.effectiveFrom)}</td>
                    <td className="text-right tabular-nums">{formatMoney(c.baseSalaryVnd)}</td>
                    <td className="text-right tabular-nums">{formatMoney(c.allowanceVnd + c.mealVnd + c.transportVnd + c.dutyVnd)}</td>
                    <td className="text-right tabular-nums">{formatMoney(c.insuranceSalaryVnd)}</td>
                    <td className="text-right tabular-nums">{c.dependents}</td>
                  </>
                ) : (
                  <td colSpan={5}><Badge tone="crit">Không có hợp đồng hiệu lực trong tháng</Badge></td>
                )}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="py-8 text-center text-muted">Chưa có nhân sự nào làm việc trong tháng {month}/{year}.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
