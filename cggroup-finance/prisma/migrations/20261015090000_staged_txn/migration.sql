-- CreateTable
CREATE TABLE "StagedTxn" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "ref" TEXT,
    "date" DATE NOT NULL,
    "direction" "Direction" NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "fxRate" DECIMAL(18,6) NOT NULL,
    "shopId" TEXT,
    "accountId" TEXT,
    "categoryId" TEXT,
    "supplierId" TEXT,
    "incomeGl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "cashTxnId" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StagedTxn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StagedTotal" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "usd" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "StagedTotal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StagedTxn_cashTxnId_key" ON "StagedTxn"("cashTxnId");

-- CreateIndex
CREATE INDEX "StagedTxn_year_month_team_idx" ON "StagedTxn"("year", "month", "team");

-- CreateIndex
CREATE UNIQUE INDEX "StagedTxn_source_line_key" ON "StagedTxn"("source", "line");

-- CreateIndex
CREATE UNIQUE INDEX "StagedTotal_source_key_key" ON "StagedTotal"("source", "key");


ALTER TABLE "StagedTxn" ADD CONSTRAINT staged_txn_status CHECK (status IN ('DRAFT', 'SKIP', 'LOCKED'));
ALTER TABLE "StagedTxn" ADD CONSTRAINT staged_txn_amount CHECK (amount >= 0);

-- Dòng đã chốt (đã thành giao dịch Sổ quỹ): khoá vĩnh viễn — sửa bằng cách huỷ giao dịch ở Sổ quỹ.
CREATE FUNCTION staged_txn_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'LOCKED' THEN
    RAISE EXCEPTION 'Dòng % #% đã chốt — không sửa được nữa', OLD.source, OLD.line;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER staged_txn_locked BEFORE UPDATE OR DELETE ON "StagedTxn"
  FOR EACH ROW EXECUTE FUNCTION staged_txn_guard();
