-- Chốt chặn GĐ2 ở tầng DB — các ràng buộc nghiệp vụ trong đặc tả GĐ2 mục 03.

-- 1. Hợp đồng: tăng lương = bản ghi mới. Chỉ được đóng hợp đồng (effectiveTo) và ghi chú.
CREATE FUNCTION contract_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Khong duoc xoa hop dong — dong hop dong bang effectiveTo';
  END IF;
  IF NEW."employeeId" IS DISTINCT FROM OLD."employeeId"
     OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
     OR NEW."baseSalaryVnd" IS DISTINCT FROM OLD."baseSalaryVnd"
     OR NEW."allowanceVnd" IS DISTINCT FROM OLD."allowanceVnd"
     OR NEW."mealVnd" IS DISTINCT FROM OLD."mealVnd"
     OR NEW."transportVnd" IS DISTINCT FROM OLD."transportVnd"
     OR NEW."dutyVnd" IS DISTINCT FROM OLD."dutyVnd"
     OR NEW."insuranceSalaryVnd" IS DISTINCT FROM OLD."insuranceSalaryVnd"
     OR NEW."dependents" IS DISTINCT FROM OLD."dependents" THEN
    RAISE EXCEPTION 'Hop dong khong duoc sua de — tao hop dong moi';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER contract_immutable BEFORE UPDATE OR DELETE ON "EmploymentContract"
  FOR EACH ROW EXECUTE FUNCTION contract_guard();

ALTER TABLE "EmploymentContract" ADD CONSTRAINT contract_amounts CHECK (
  "baseSalaryVnd" >= 0 AND "allowanceVnd" >= 0 AND "mealVnd" >= 0 AND "transportVnd" >= 0
  AND "dutyVnd" >= 0 AND "insuranceSalaryVnd" >= 0 AND "dependents" >= 0
  AND ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);

-- Một người không có hai hợp đồng hiệu lực chồng nhau → tra lương tháng nào cũng ra đúng một số.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "EmploymentContract" ADD CONSTRAINT contract_no_overlap EXCLUDE USING gist (
  "employeeId" WITH =,
  daterange("effectiveFrom", "effectiveTo", '[]') WITH &&
);

-- 2. Chấm công: chỉ 0 / 0,5 / 1.
ALTER TABLE "AttendanceDay" ADD CONSTRAINT attendance_value CHECK ("value" IN (0, 0.5, 1));

-- 3. Đơn nghỉ và kỳ lương hợp lệ.
ALTER TABLE "LeaveRequest"  ADD CONSTRAINT leave_range  CHECK ("toDate" >= "fromDate" AND "days" > 0);
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT period_month CHECK ("month" BETWEEN 1 AND 12 AND "standardDays" > 0);

-- 4. Dòng lương bất biến khi kỳ đã APPROVED/PAID/CLOSED.
CREATE FUNCTION payroll_line_guard() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
  SELECT status INTO st FROM "PayrollPeriod"
   WHERE id = COALESCE(NEW."periodId", OLD."periodId");
  IF st IN ('APPROVED', 'PAID', 'CLOSED') THEN
    RAISE EXCEPTION 'Ky luong da % — dong luong khong duoc thay doi', st;
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_line_locked BEFORE INSERT OR UPDATE OR DELETE ON "PayrollLine"
  FOR EACH ROW EXECUTE FUNCTION payroll_line_guard();

-- 5. Kỳ lương đã duyệt không xoá được; kỳ CLOSED không sửa được.
CREATE FUNCTION payroll_period_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' AND OLD.status <> 'CALCULATED' THEN
      RAISE EXCEPTION 'Ky luong da % — khong duoc xoa', OLD.status;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'Ky luong da CLOSED — bat bien, dieu chinh qua ky ke tiep';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_period_locked BEFORE UPDATE OR DELETE ON "PayrollPeriod"
  FOR EACH ROW EXECUTE FUNCTION payroll_period_guard();
