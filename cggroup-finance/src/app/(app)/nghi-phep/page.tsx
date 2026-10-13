import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { bizDateStr, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { Badge, Field, Flash, PageHead } from "../ui";
import { createLeaveAction, decideLeave, setEntitlement } from "./actions";

const STATUS = { PENDING: ["Chờ duyệt", "accent"], APPROVED: ["Đã duyệt", "good"], REJECTED: ["Từ chối / huỷ", "muted"] } as const;

export default async function LeavePage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const me = await requireUser();
  const sp = await searchParams;
  const hr = me.role === "ADMIN" || me.role === "QUAN_LY";
  const today = todayVn();
  const year = today.getUTCFullYear();
  const own = await prisma.employee.findUnique({ where: { userId: me.uid } });
  const scope: Prisma.LeaveRequestWhereInput = hr ? {} : { employeeId: own?.id ?? "__none__" };

  const [types, employees, requests, balances] = await Promise.all([
    prisma.leaveType.findMany({ orderBy: { name: "asc" } }),
    hr ? prisma.employee.findMany({ where: { status: { not: "RESIGNED" } }, orderBy: { code: "asc" } }) : Promise.resolve(own ? [own] : []),
    prisma.leaveRequest.findMany({ where: scope, include: { employee: true, leaveType: true }, orderBy: [{ status: "asc" }, { fromDate: "desc" }], take: 200 }),
    prisma.leaveBalance.findMany({ where: { year, ...(hr ? {} : { employeeId: own?.id ?? "__none__" }) } }),
  ]);
  const quotaTypes = types.filter((t) => t.daysPerYear !== null);
  const balBy = new Map(balances.map((b) => [`${b.employeeId}_${b.leaveTypeId}`, b]));

  return (
    <div className="max-w-6xl">
      <PageHead no={12} title="Nghỉ phép" />
      <Flash ok={sp.ok} error={sp.error} />
      {!hr && !own && (
        <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm">Tài khoản của bạn chưa gắn với hồ sơ nhân sự — nhờ quản lý gắn ở màn 9 để gửi đơn nghỉ.</p>
      )}

      {(hr || own) && (
        <form action={createLeaveAction} className="card mt-5 p-5">
          <h2 className="font-bold">Đơn nghỉ</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {hr && <Field name="employeeId" label="Nhân sự" required empty="Chọn…" defaultValue={own?.id} options={employees.map((e) => ({ value: e.id, label: `${e.code} · ${e.fullName}` }))} />}
            <Field name="leaveTypeId" label="Loại nghỉ" required empty="Chọn…" options={types.map((t) => ({ value: t.id, label: `${t.name}${t.paid ? "" : " (không lương)"}` }))} />
            <Field name="fromDate" label="Từ ngày" type="date" required defaultValue={bizDateStr(today)} />
            <Field name="toDate" label="Đến ngày" type="date" help="Trống = nghỉ 1 ngày" />
            <Field name="days" label="Số ngày" inputMode="decimal" placeholder="Tự tính" help="Trống = số ngày T2–T7 trừ lễ; nửa ngày ghi 0,5" />
            <Field name="reason" label="Lý do" />
          </div>
          <button className="btn-primary mt-5" type="submit">Gửi đơn</button>
        </form>
      )}

      <section className="mt-6">
        <h2 className="font-bold">Số dư phép năm {year}</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr><th>Nhân sự</th>{quotaTypes.map((t) => <th key={t.id} className="text-right">{t.name} (còn / định mức)</th>)}</tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap"><span className="font-mono text-xs text-muted">{e.code}</span> {e.fullName}</td>
                  {quotaTypes.map((t) => {
                    const b = balBy.get(`${e.id}_${t.id}`);
                    const entitled = b ? Number(b.entitled) : Number(t.daysPerYear);
                    const used = b ? Number(b.used) : 0;
                    return (
                      <td key={t.id} className="text-right">
                        <span className={`font-semibold tabular-nums ${entitled - used <= 0 ? "text-crit" : ""}`}>{(entitled - used).toLocaleString("vi-VN")}</span>
                        <span className="text-muted"> / {entitled.toLocaleString("vi-VN")}</span>
                        {hr && (
                          <details className="inline-block align-middle">
                            <summary className="ml-2 cursor-pointer text-xs text-accent">sửa</summary>
                            <form action={setEntitlement} className="mt-1 flex gap-1">
                              <input type="hidden" name="employeeId" value={e.id} />
                              <input type="hidden" name="leaveTypeId" value={t.id} />
                              <input type="hidden" name="year" value={year} />
                              <input className="input w-16" name="entitled" defaultValue={entitled} aria-label="Định mức" />
                              <button className="btn" type="submit">OK</button>
                            </form>
                          </details>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="font-bold">Đơn nghỉ</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Nhân sự</th><th>Loại</th><th>Thời gian</th><th className="text-right">Ngày</th><th>Lý do</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{r.employee.code} · {r.employee.fullName}</td>
                  <td>{r.leaveType.name}{!r.leaveType.paid && <span className="text-xs text-muted"> (không lương)</span>}</td>
                  <td className="whitespace-nowrap tabular-nums">{fmtBizDate(r.fromDate)}{r.toDate > r.fromDate && ` → ${fmtBizDate(r.toDate)}`}</td>
                  <td className="text-right tabular-nums">{Number(r.days).toLocaleString("vi-VN")}</td>
                  <td>{r.reason}</td>
                  <td><Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge></td>
                  <td className="whitespace-nowrap">
                    {hr && r.status === "PENDING" && (
                      <span className="flex gap-2">
                        <form action={decideLeave.bind(null, r.id, true)}><button className="btn-primary" type="submit">Duyệt</button></form>
                        <form action={decideLeave.bind(null, r.id, false)}><button className="btn" type="submit">Từ chối</button></form>
                      </span>
                    )}
                    {hr && r.status === "APPROVED" && (
                      <form action={decideLeave.bind(null, r.id, false)}><button className="text-xs text-crit hover:underline" type="submit">Huỷ đơn (hoàn phép)</button></form>
                    )}
                  </td>
                </tr>
              ))}
              {!requests.length && <tr><td colSpan={7} className="py-6 text-center text-muted">Chưa có đơn nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
