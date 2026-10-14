-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "targetId" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_kind_key_key" ON "ImportRow"("kind", "key");


ALTER TABLE "ImportRow" ADD CONSTRAINT import_row_kind CHECK (kind IN ('ENTITY', 'ACCOUNT', 'EMPLOYEE', 'SHOP', 'CONTRACT'));
ALTER TABLE "ImportRow" ADD CONSTRAINT import_row_status CHECK (status IN ('DRAFT', 'LOCKED'));

-- Dòng đã chốt: khoá vĩnh viễn — không sửa, không xoá (sửa tiếp ở màn nghiệp vụ, có audit).
CREATE FUNCTION import_row_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'LOCKED' THEN
    RAISE EXCEPTION 'Dòng % % đã chốt — không sửa được nữa', OLD.kind, OLD.key;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER import_row_locked BEFORE UPDATE OR DELETE ON "ImportRow"
  FOR EACH ROW EXECUTE FUNCTION import_row_guard();
