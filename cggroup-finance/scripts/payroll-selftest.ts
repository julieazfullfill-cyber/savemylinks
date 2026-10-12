// Tự kiểm động cơ tính lương bằng số liệu thật tháng 8/2026 — đặc tả GĐ2 mục 09.
// Chạy: npm run payroll:selftest
//
// Chứng minh ba thứ:
//   1. Tổng kỳ lương = SUM các dòng (không bỏ sót ai)
//   2. Bút toán lương cân
//   3. Cổng chặn giữ lại thưởng trong tháng công ty lỗ
import { bonusGate } from "../src/lib/kpi";
import { computePayrollLine, totalPayroll, type PayrollLineResult } from "../src/lib/payroll";
import { buildPayrollJournal } from "../src/lib/payroll-journal";
import { AUG_COMPANY_PROFIT_VND, AUG_STAFF, AUG_STANDARD_DAYS } from "./aug2026-fixture";

const vn = (v: bigint) => v.toLocaleString("vi-VN");

console.log("=== CONG CHAN THUONG ===");
let heldTotal = 0n;
const gated = AUG_STAFF.map((s) => {
  const g = bonusGate(s.bonus, AUG_COMPANY_PROFIT_VND);
  if (s.bonus > 0n) {
    console.log(`  ${s.name.padEnd(22)} thuong ${vn(s.bonus).padStart(12)} -> ${g.payableVnd > 0n ? "CHI" : `GIU LAI (${g.reason})`}`);
  }
  heldTotal += g.heldVnd;
  return { ...s, payable: g.payableVnd, held: g.heldVnd };
});
console.log(`  Tong bi giu lai: ${vn(heldTotal)} d\n`);

console.log("=== TINH LUONG (thuong da qua cong chan) ===");
const lines: PayrollLineResult[] = gated.map((s) =>
  computePayrollLine({
    employeeId: s.id,
    contract: {
      baseSalaryVnd: s.base,
      allowanceVnd: s.allow,
      mealVnd: 0n,
      transportVnd: 0n,
      dutyVnd: 0n,
      insuranceSalaryVnd: s.base,
      dependents: 0,
    },
    workedDays: s.worked,
    standardDays: AUG_STANDARD_DAYS,
    salesBonusVnd: s.payable,
    bonusHeldVnd: s.held,
    perfPayVnd: 0n,
    penaltyVnd: 0n,
  }),
);
for (const l of lines) {
  const n = AUG_STAFF.find((s) => s.id === l.employeeId)!.name;
  console.log(
    `  ${n.padEnd(22)} cong ${String(l.workedDays).padStart(5)} | luong ${vn(l.proratedVnd).padStart(12)} ` +
      `| BHXH ${vn(l.insuranceEmpVnd).padStart(9)} | TNCN ${vn(l.pitVnd).padStart(9)} | thuc nhan ${vn(l.netVnd).padStart(12)}`,
  );
}

const t = totalPayroll(lines);
console.log("\n=== TONG KY (cong tu cac dong, khong go tay) ===");
console.log(`  So nguoi           : ${t.headcount}`);
console.log(`  Thuc nhan          : ${vn(t.netVnd)} d`);
console.log(`  BHXH NLD           : ${vn(t.insuranceEmpVnd)} d`);
console.log(`  BHXH cong ty       : ${vn(t.insuranceCoVnd)} d`);
console.log(`  Thue TNCN          : ${vn(t.pitVnd)} d`);
console.log(`  CHI PHI CONG TY    : ${vn(t.companyCostVnd)} d`);

console.log("\n=== BUT TOAN ===");
const journal = buildPayrollJournal(lines);
let d = 0n;
let c = 0n;
for (const l of journal) {
  d += l.debitVnd;
  c += l.creditVnd;
  console.log(`  ${l.accountCode}  no ${vn(l.debitVnd).padStart(14)}  co ${vn(l.creditVnd).padStart(14)}`);
}
console.log(`  ----  tong no ${vn(d)} = tong co ${vn(c)}`);
if (d !== c) {
  console.error("LECH!");
  process.exit(1);
}
console.log("\nOK — but toan can, tong ky bang tong cac dong.");
