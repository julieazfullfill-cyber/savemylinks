import type { EmployeeStatus, Prisma, WorkMode } from "@prisma/client";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { fmtBizDate } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { MODE_LABEL, STATUS_LABEL } from "@/lib/hr-forms";
import { Badge, Field, PageHead } from "../ui";

const statusTone = { PROBATION: "accent", OFFICIAL: "good", RESIGNED: "muted" } as const;

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ dept?: string; status?: string; mode?: string; q?: string }>;
}) {
  await requireUser(["ADMIN", "QUAN_LY"]);
  const sp = await searchParams;
  // Mặc định ẩn người đã nghỉ; chọn "Đã nghỉ" hoặc "Tất cả" để xem.
  const status = sp.status ?? "ACTIVE";
  const where: Prisma.EmployeeWhereInput = {
    ...(sp.dept ? { departmentId: sp.dept } : {}),
    ...(sp.mode ? { workMode: sp.mode as WorkMode } : {}),
    ...(status === "ACTIVE" ? { status: { not: "RESIGNED" } } : status !== "ALL" ? { status: status as EmployeeStatus } : {}),
    ...(sp.q ? { OR: [{ fullName: { contains: sp.q, mode: "insensitive" } }, { code: { contains: sp.q, mode: "insensitive" } }] } : {}),
  };
  const [employees, departments] = await Promise.all([
    prisma.employee.findMany({
      where,
      include: { department: true, position: true, manager: true, _count: { select: { contracts: true } } },
      orderBy: { code: "asc" },
    }),
    prisma.department.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="max-w-6xl">
      <PageHead no={9} title="Hồ sơ nhân sự">
        <Link className="btn-primary" href="/nhan-su/moi">+ Thêm nhân sự</Link>
      </PageHead>

      <form className="card mt-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5" method="get">
        <Field name="q" label="Tìm" placeholder="Tên hoặc mã" defaultValue={sp.q} />
        <Field name="dept" label="Phòng ban" defaultValue={sp.dept} empty="Tất cả" options={departments.map((d) => ({ value: d.id, label: d.name }))} />
        <Field
          name="status"
          label="Trạng thái"
          defaultValue={status}
          empty={false}
          options={[
            { value: "ACTIVE", label: "Đang làm" },
            ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
            { value: "ALL", label: "Tất cả" },
          ]}
        />
        <Field name="mode" label="Hình thức" defaultValue={sp.mode} empty="Tất cả" options={Object.entries(MODE_LABEL).map(([value, label]) => ({ value, label }))} />
        <div className="flex items-end gap-2">
          <button className="btn-primary" type="submit">Lọc</button>
          <Link className="btn" href="/nhan-su">Xoá lọc</Link>
        </div>
      </form>

      <div className="card mt-4 overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Mã</th><th>Họ tên</th><th>Phòng ban</th><th>Chức danh</th><th>Quản lý</th>
              <th>Trạng thái</th><th>Hình thức</th><th>Vào làm</th><th>Hợp đồng</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <td className="font-mono text-xs">{e.code}</td>
                <td><Link className="font-semibold text-accent hover:underline" href={`/nhan-su/${e.id}`}>{e.fullName}</Link></td>
                <td>{e.department?.name ?? <span className="text-muted">—</span>}</td>
                <td>{e.position?.name ?? <span className="text-muted">—</span>}</td>
                <td>{e.manager?.fullName ?? <span className="text-muted">—</span>}</td>
                <td><Badge tone={statusTone[e.status]}>{STATUS_LABEL[e.status]}</Badge></td>
                <td>{MODE_LABEL[e.workMode]}</td>
                <td className="tabular-nums">{fmtBizDate(e.joinedAt)}</td>
                <td>{e._count.contracts ? e._count.contracts : <Badge tone="crit">Chưa có</Badge>}</td>
              </tr>
            ))}
            {!employees.length && (
              <tr><td colSpan={9} className="py-8 text-center text-muted">Không có nhân sự nào khớp bộ lọc.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">{employees.length} người</p>
    </div>
  );
}
