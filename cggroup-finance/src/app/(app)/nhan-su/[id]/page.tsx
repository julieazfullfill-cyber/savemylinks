import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { bizDateStr, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { MODE_LABEL, STATUS_LABEL } from "@/lib/hr-forms";
import { formatMoney } from "@/lib/money";
import { Badge, Field, Flash, PageHead } from "../../ui";
import { addContractAction, saveEmployee } from "../actions";

const opts = (rec: Record<string, string>) => Object.entries(rec).map(([value, label]) => ({ value, label }));

export default async function EmployeePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string; cerror?: string }>;
}) {
  await requireUser(["ADMIN", "QUAN_LY"]);
  const { id } = await params;
  const sp = await searchParams;
  const isNew = id === "moi";

  const [emp, departments, positions, others, users] = await Promise.all([
    isNew ? null : prisma.employee.findUnique({ where: { id }, include: { contracts: { orderBy: { effectiveFrom: "desc" } } } }),
    prisma.department.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.position.findMany({ orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { status: { not: "RESIGNED" }, ...(isNew ? {} : { id: { not: id } }) }, orderBy: { fullName: "asc" } }),
    prisma.user.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
  ]);
  if (!isNew && !emp) notFound();

  const save = saveEmployee.bind(null, isNew ? null : id);
  const today = todayVn();
  const current = emp?.contracts.find((c) => c.effectiveFrom <= today && (!c.effectiveTo || c.effectiveTo >= today));

  return (
    <div className="max-w-5xl">
      <Link href="/nhan-su" className="text-sm text-accent hover:underline">← Danh sách nhân sự</Link>
      <div className="mt-2">
        <PageHead no={9} title={emp ? `${emp.code} · ${emp.fullName}` : "Thêm nhân sự"}>
          {emp && <Badge tone={emp.status === "RESIGNED" ? "muted" : "good"}>{STATUS_LABEL[emp.status]}</Badge>}
        </PageHead>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      <form action={save} className="card mt-4 p-5">
        <h2 className="font-bold">Hồ sơ</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field name="code" label="Mã nhân sự" required defaultValue={emp?.code} placeholder="NV01" />
          <Field name="fullName" label="Họ tên" required defaultValue={emp?.fullName} />
          <Field name="departmentId" label="Phòng ban" defaultValue={emp?.departmentId} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
          <Field name="positionId" label="Chức danh" defaultValue={emp?.positionId} options={positions.map((p) => ({ value: p.id, label: p.name }))} />
          <Field name="managerId" label="Quản lý trực tiếp" defaultValue={emp?.managerId} options={others.map((o) => ({ value: o.id, label: `${o.code} · ${o.fullName}` }))} />
          <Field name="userId" label="Tài khoản đăng nhập" defaultValue={emp?.userId} help="Để nhân viên xem phiếu lương của mình" options={users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))} />
          <Field name="status" label="Trạng thái" required empty={false} defaultValue={emp?.status ?? "PROBATION"} options={opts(STATUS_LABEL)} />
          <Field name="workMode" label="Hình thức làm việc" required empty={false} defaultValue={emp?.workMode ?? "OFFICE"} options={opts(MODE_LABEL)} help="ONL là thuộc tính của người, không phải của ngày" />
          <Field name="joinedAt" label="Ngày vào làm" type="date" required defaultValue={emp ? bizDateStr(emp.joinedAt) : ""} />
          <Field name="leftAt" label="Ngày nghỉ việc" type="date" defaultValue={emp?.leftAt ? bizDateStr(emp.leftAt) : ""} help="Chỉ điền khi trạng thái là Đã nghỉ" />
          <Field name="bankAccount" label="Số tài khoản" defaultValue={emp?.bankAccount} />
          <Field name="bankName" label="Ngân hàng" defaultValue={emp?.bankName} />
        </div>
        <div className="mt-5"><button className="btn-primary" type="submit">{isNew ? "Thêm nhân sự" : "Lưu hồ sơ"}</button></div>
      </form>

      {emp && (
        <section id="hop-dong" className="mt-8">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-muted">Màn hình 10</div>
              <h2 className="text-lg font-bold">Hợp đồng & lương</h2>
            </div>
            {current && <div className="text-sm text-ink-2">Lương cứng hiện tại: <strong className="tabular-nums">{formatMoney(current.baseSalaryVnd)}</strong></div>}
          </div>

          <div className="card mt-3 overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Hiệu lực</th><th className="text-right">Lương cứng</th><th className="text-right">Phụ cấp</th>
                  <th className="text-right">Ăn</th><th className="text-right">Đi lại</th><th className="text-right">Trách nhiệm</th>
                  <th className="text-right">Lương đóng BH</th><th className="text-right">NPT</th><th>Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {emp.contracts.map((c) => (
                  <tr key={c.id} className={c === current ? "bg-accent/5" : ""}>
                    <td className="whitespace-nowrap tabular-nums">
                      {fmtBizDate(c.effectiveFrom)} → {c.effectiveTo ? fmtBizDate(c.effectiveTo) : "nay"}
                      {c === current && <span className="ml-2"><Badge tone="accent">Hiện hành</Badge></span>}
                    </td>
                    {[c.baseSalaryVnd, c.allowanceVnd, c.mealVnd, c.transportVnd, c.dutyVnd, c.insuranceSalaryVnd].map((v, i) => (
                      <td key={i} className="text-right tabular-nums">{v ? formatMoney(v) : <span className="text-muted">—</span>}</td>
                    ))}
                    <td className="text-right tabular-nums">{c.dependents}</td>
                    <td>{c.note ?? ""}</td>
                  </tr>
                ))}
                {!emp.contracts.length && (
                  <tr><td colSpan={9} className="py-6 text-center text-crit">Chưa có hợp đồng — kỳ lương sẽ báo lỗi cho người này.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <form action={addContractAction.bind(null, emp.id)} className="card mt-4 p-5">
            <h3 className="font-bold">Thêm hợp đồng mới</h3>
            <p className="mt-1 text-sm text-muted">
              Tăng lương hay đổi điều khoản đều là hợp đồng mới — hợp đồng đang mở sẽ tự đóng vào ngày hôm trước.
              Hợp đồng đã tạo không sửa được.
            </p>
            <Flash error={sp.cerror} />
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field name="effectiveFrom" label="Hiệu lực từ" type="date" required />
              <Field name="baseSalaryVnd" label="Lương cứng (đ)" required inputMode="numeric" placeholder="11.500.000" />
              <Field name="allowanceVnd" label="Phụ cấp chung (đ)" inputMode="numeric" />
              <Field name="mealVnd" label="Phụ cấp ăn (đ)" inputMode="numeric" help="Miễn thuế đến trần trong PayrollSetting" />
              <Field name="transportVnd" label="Đi lại (đ)" inputMode="numeric" />
              <Field name="dutyVnd" label="Trách nhiệm (đ)" inputMode="numeric" />
              <Field name="insuranceSalaryVnd" label="Lương đóng BHXH (đ)" inputMode="numeric" help="Để trống = không đóng BHXH" />
              <Field name="dependents" label="Người phụ thuộc" type="number" min={0} max={20} defaultValue={String(current?.dependents ?? 0)} />
            </div>
            <div className="mt-4"><Field name="note" label="Ghi chú" placeholder="Tăng lương sau đánh giá Q4…" /></div>
            <div className="mt-5"><button className="btn-primary" type="submit">Thêm hợp đồng</button></div>
          </form>
        </section>
      )}
    </div>
  );
}
