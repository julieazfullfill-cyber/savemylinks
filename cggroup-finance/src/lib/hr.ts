// Nhân sự & hợp đồng — màn hình 9, 10 (đặc tả GĐ2 mục 10).
import { audit } from "./audit";
import { addDays, bizDateStr } from "./dates";
import type { Tx } from "./db";

export type ContractInput = {
  employeeId: string;
  effectiveFrom: Date;
  baseSalaryVnd: bigint;
  allowanceVnd: bigint;
  mealVnd: bigint;
  transportVnd: bigint;
  dutyVnd: bigint;
  insuranceSalaryVnd: bigint;
  dependents: number;
  note?: string | null;
  actorId: string;
};

/**
 * Tăng lương / đổi điều khoản = thêm hợp đồng mới, không sửa đè (trigger chặn).
 * Hợp đồng đang mở (effectiveTo null) bắt đầu trước ngày mới sẽ được đóng vào ngày hôm trước.
 * Hợp đồng mới phải sau hợp đồng gần nhất — không chèn vào quá khứ đã có hợp đồng.
 */
export async function addContract(tx: Tx, input: ContractInput) {
  const { actorId, ...data } = input;
  const latest = await tx.employmentContract.findFirst({
    where: { employeeId: data.employeeId },
    orderBy: { effectiveFrom: "desc" },
  });
  if (latest && data.effectiveFrom <= latest.effectiveFrom) {
    throw new Error(`Ngày hiệu lực phải sau hợp đồng gần nhất (${bizDateStr(latest.effectiveFrom)})`);
  }
  if (latest && latest.effectiveTo === null) {
    const closed = await tx.employmentContract.update({
      where: { id: latest.id },
      data: { effectiveTo: addDays(data.effectiveFrom, -1) },
    });
    await audit(tx, { actorId, tableName: "EmploymentContract", recordId: latest.id, action: "UPDATE", before: latest, after: closed });
  }
  const created = await tx.employmentContract.create({ data });
  await audit(tx, { actorId, tableName: "EmploymentContract", recordId: created.id, action: "CREATE", after: created });
  return created;
}
