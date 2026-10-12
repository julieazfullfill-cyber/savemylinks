-- Các ràng buộc Prisma không diễn tả được. Xem đặc tả mục 01–02.

-- 1. Tổng nợ = tổng có cho mỗi bút toán. DEFERRABLE INITIALLY DEFERRED để chèn
--    từng dòng trong một transaction rồi mới kiểm lúc commit.
CREATE FUNCTION check_journal_balanced() RETURNS trigger AS $$
DECLARE d BIGINT; c BIGINT; n INT;
BEGIN
  SELECT COALESCE(SUM("debitVnd"),0), COALESCE(SUM("creditVnd"),0), COUNT(*)
    INTO d, c, n FROM "JournalLine" WHERE "entryId" = NEW."entryId";
  IF d <> c THEN
    RAISE EXCEPTION 'But toan lech: no=% co=% (entry %)', d, c, NEW."entryId";
  END IF;
  IF n < 2 THEN
    RAISE EXCEPTION 'But toan can it nhat 2 dong (entry %)', NEW."entryId";
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_balanced
  AFTER INSERT OR UPDATE ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_balanced();

-- 2. Mỗi dòng bút toán: không âm, đúng một phía nợ hoặc có.
ALTER TABLE "JournalLine" ADD CONSTRAINT journal_line_one_side CHECK (
  "debitVnd" >= 0 AND "creditVnd" >= 0 AND (("debitVnd" > 0) <> ("creditVnd" > 0))
);

-- 3. Số tiền luôn dương; hướng nằm ở cột direction.
ALTER TABLE "CashTxn"      ADD CONSTRAINT cash_txn_positive      CHECK ("amount" > 0 AND "amountVnd" > 0);
ALTER TABLE "Expense"      ADD CONSTRAINT expense_positive       CHECK ("amount" > 0 AND "amountVnd" > 0);
ALTER TABLE "SupplierBill" ADD CONSTRAINT supplier_bill_positive CHECK ("amount" > 0 AND "amountVnd" > 0 AND "paidVnd" >= 0);
ALTER TABLE "FxRate"       ADD CONSTRAINT fx_rate_positive       CHECK ("rate" > 0);

-- 4. Không xoá bản ghi tài chính — kể cả ADMIN. Sửa bằng void + bút toán ngược.
CREATE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Khong duoc xoa ban ghi % — dung voidedAt hoac but toan nguoc', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER no_delete_cash_txn      BEFORE DELETE ON "CashTxn"      FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_journal_entry BEFORE DELETE ON "JournalEntry" FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_journal_line  BEFORE DELETE ON "JournalLine"  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_audit_log     BEFORE DELETE ON "AuditLog"     FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 5. Dòng bút toán đã ghi là bất biến — sửa bằng bút toán ngược.
CREATE FUNCTION forbid_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Bang % chi duoc ghi them, khong duoc sua', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_journal_line BEFORE UPDATE ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER no_update_audit_log    BEFORE UPDATE ON "AuditLog"    FOR EACH ROW EXECUTE FUNCTION forbid_update();
