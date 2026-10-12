// Đọc và kiểm tra form màn hình 9 (nhân sự) và 10 (hợp đồng). Hàm thuần, ném Error tiếng Việt.
import type { EmployeeStatus, WorkMode } from "@prisma/client";
import { parseBizDate } from "./dates";
import { toMinor } from "./money";

export const STATUS_LABEL: Record<EmployeeStatus, string> = {
  PROBATION: "Thử việc",
  OFFICIAL: "Chính thức",
  RESIGNED: "Đã nghỉ",
};
export const MODE_LABEL: Record<WorkMode, string> = { OFFICE: "Văn phòng", ONLINE: "Online", HYBRID: "Kết hợp" };

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const opt = (f: FormData, k: string) => str(f, k) || null;
const optDate = (f: FormData, k: string) => (str(f, k) ? parseBizDate(str(f, k)) : null);

export function parseEmployeeForm(f: FormData) {
  const code = str(f, "code").toUpperCase();
  const fullName = str(f, "fullName");
  if (!code) throw new Error("Thiếu mã nhân sự");
  if (!fullName) throw new Error("Thiếu họ tên");
  const status = str(f, "status") as EmployeeStatus;
  const workMode = str(f, "workMode") as WorkMode;
  if (!(status in STATUS_LABEL)) throw new Error("Trạng thái không hợp lệ");
  if (!(workMode in MODE_LABEL)) throw new Error("Hình thức làm việc không hợp lệ");
  if (!str(f, "joinedAt")) throw new Error("Thiếu ngày vào làm");
  const joinedAt = parseBizDate(str(f, "joinedAt"));
  const leftAt = optDate(f, "leftAt");
  if (leftAt && leftAt < joinedAt) throw new Error("Ngày nghỉ việc phải sau ngày vào làm");
  if (status === "RESIGNED" && !leftAt) throw new Error("Nhân sự đã nghỉ cần có ngày nghỉ việc");
  if (status !== "RESIGNED" && leftAt) throw new Error("Có ngày nghỉ việc thì trạng thái phải là Đã nghỉ");
  return {
    code,
    fullName,
    departmentId: opt(f, "departmentId"),
    positionId: opt(f, "positionId"),
    managerId: opt(f, "managerId"),
    userId: opt(f, "userId"),
    status,
    workMode,
    joinedAt,
    leftAt,
    bankAccount: opt(f, "bankAccount"),
    bankName: opt(f, "bankName"),
  };
}

const MONEY_FIELDS = ["baseSalaryVnd", "allowanceVnd", "mealVnd", "transportVnd", "dutyVnd", "insuranceSalaryVnd"] as const;

export function parseContractForm(f: FormData) {
  if (!str(f, "effectiveFrom")) throw new Error("Thiếu ngày hiệu lực");
  const money = {} as Record<(typeof MONEY_FIELDS)[number], bigint>;
  for (const k of MONEY_FIELDS) {
    const raw = str(f, k);
    if (!raw && k === "baseSalaryVnd") throw new Error("Thiếu lương cứng");
    const v = raw ? toMinor(raw, "VND") : 0n;
    if (v < 0n) throw new Error("Số tiền không được âm");
    money[k] = v;
  }
  if (money.baseSalaryVnd <= 0n) throw new Error("Lương cứng phải lớn hơn 0");
  const dep = str(f, "dependents") || "0";
  if (!/^\d+$/.test(dep) || Number(dep) > 20) throw new Error("Số người phụ thuộc không hợp lệ");
  return {
    effectiveFrom: parseBizDate(str(f, "effectiveFrom")),
    ...money,
    dependents: Number(dep),
    note: opt(f, "note"),
  };
}
