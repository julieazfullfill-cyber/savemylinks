"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { addContract } from "@/lib/hr";
import { parseContractForm, parseEmployeeForm } from "@/lib/hr-forms";

const HR = ["ADMIN", "QUAN_LY"] as const;

function friendly(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  if (m.includes("Unique constraint") && m.includes("userId")) return "Tài khoản đăng nhập này đã gắn với nhân sự khác";
  if (m.includes("Unique constraint")) return "Mã nhân sự đã tồn tại";
  if (m.includes("contract_no_overlap")) return "Hợp đồng chồng thời gian với hợp đồng khác";
  return m;
}

export async function saveEmployee(id: string | null, form: FormData) {
  const me = await requireUser([...HR]);
  const back = id ?? "moi";
  let data: ReturnType<typeof parseEmployeeForm>;
  try {
    data = parseEmployeeForm(form);
    if (id && data.managerId === id) throw new Error("Không thể tự làm quản lý của chính mình");
  } catch (e) {
    return redirect(`/nhan-su/${back}?error=${encodeURIComponent(friendly(e))}`);
  }

  let savedId = id;
  try {
    savedId = await prisma.$transaction(async (tx) => {
      if (id) {
        const before = await tx.employee.findUniqueOrThrow({ where: { id } });
        const after = await tx.employee.update({ where: { id }, data });
        await audit(tx, { actorId: me.uid, tableName: "Employee", recordId: id, action: "UPDATE", before, after });
        return id;
      }
      const after = await tx.employee.create({ data });
      await audit(tx, { actorId: me.uid, tableName: "Employee", recordId: after.id, action: "CREATE", after });
      return after.id;
    });
  } catch (e) {
    return redirect(`/nhan-su/${back}?error=${encodeURIComponent(friendly(e))}`);
  }
  revalidatePath("/nhan-su");
  redirect(`/nhan-su/${savedId}?ok=${encodeURIComponent(id ? "Đã lưu hồ sơ" : "Đã thêm nhân sự — thêm hợp đồng bên dưới")}`);
}

export async function addContractAction(employeeId: string, form: FormData) {
  const me = await requireUser([...HR]);
  try {
    const data = parseContractForm(form);
    await prisma.$transaction((tx) => addContract(tx, { ...data, employeeId, actorId: me.uid }));
  } catch (e) {
    return redirect(`/nhan-su/${employeeId}?cerror=${encodeURIComponent(friendly(e))}#hop-dong`);
  }
  revalidatePath(`/nhan-su/${employeeId}`);
  revalidatePath("/hop-dong");
  redirect(`/nhan-su/${employeeId}?ok=${encodeURIComponent("Đã thêm hợp đồng")}#hop-dong`);
}
