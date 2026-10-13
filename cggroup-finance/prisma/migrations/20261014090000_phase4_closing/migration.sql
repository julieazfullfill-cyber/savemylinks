-- CreateEnum
CREATE TYPE "ClosingStatus" AS ENUM ('OPEN', 'CHECKING', 'CLOSED');

-- CreateEnum
CREATE TYPE "CheckLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "AllocationRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceAccounts" TEXT[],
    "basis" TEXT NOT NULL DEFAULT 'REVENUE',
    "dimension" TEXT NOT NULL DEFAULT 'SHOP',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AllocationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationRun" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "poolVnd" BIGINT NOT NULL,
    "journalId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllocationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodClosing" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "ClosingStatus" NOT NULL DEFAULT 'OPEN',
    "revenueVnd" BIGINT,
    "cogsVnd" BIGINT,
    "expenseVnd" BIGINT,
    "profitVnd" BIGINT,
    "journalId" TEXT,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PeriodClosing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataCheckRun" (
    "id" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runBy" TEXT,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "closingId" TEXT,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DataCheckRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataCheckResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "level" "CheckLevel" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "diffVnd" BIGINT,
    "href" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "DataCheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" TEXT NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "code" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "level" "CheckLevel" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "href" TEXT,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amountVnd" BIGINT NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxObligation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "kind" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "amountVnd" BIGINT NOT NULL,
    "paidVnd" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "cashTxnId" TEXT,
    "createdBy" TEXT,

    CONSTRAINT "TaxObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArInvoice" (
    "id" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "amountVnd" BIGINT NOT NULL,
    "paidVnd" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "accountCode" TEXT NOT NULL DEFAULT '409',
    "journalId" TEXT,
    "createdBy" TEXT,

    CONSTRAINT "ArInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSnapshot" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AllocationRun_journalId_key" ON "AllocationRun"("journalId");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationRun_ruleId_year_month_key" ON "AllocationRun"("ruleId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodClosing_journalId_key" ON "PeriodClosing"("journalId");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodClosing_year_month_key" ON "PeriodClosing"("year", "month");

-- CreateIndex
CREATE INDEX "DataCheckRun_year_month_idx" ON "DataCheckRun"("year", "month");

-- CreateIndex
CREATE INDEX "DataCheckResult_runId_level_idx" ON "DataCheckResult"("runId", "level");

-- CreateIndex
CREATE INDEX "AlertLog_firedAt_idx" ON "AlertLog"("firedAt");

-- CreateIndex
CREATE INDEX "AlertLog_code_resolvedAt_idx" ON "AlertLog"("code", "resolvedAt");

-- CreateIndex
CREATE INDEX "AlertLog_key_resolvedAt_idx" ON "AlertLog"("key", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_year_month_categoryId_key" ON "Budget"("year", "month", "categoryId");

-- CreateIndex
CREATE INDEX "TaxObligation_dueDate_status_idx" ON "TaxObligation"("dueDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ArInvoice_journalId_key" ON "ArInvoice"("journalId");

-- CreateIndex
CREATE INDEX "ArInvoice_dueDate_status_idx" ON "ArInvoice"("dueDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSnapshot_kind_year_month_key" ON "ReportSnapshot"("kind", "year", "month");

-- AddForeignKey
ALTER TABLE "AllocationRun" ADD CONSTRAINT "AllocationRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AllocationRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataCheckRun" ADD CONSTRAINT "DataCheckRun_closingId_fkey" FOREIGN KEY ("closingId") REFERENCES "PeriodClosing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataCheckResult" ADD CONSTRAINT "DataCheckResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DataCheckRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxObligation" ADD CONSTRAINT "TaxObligation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "LegalEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────── GĐ4: khoá kỳ đã đóng sổ ─────────────
-- Tháng đã CLOSED: không ghi thêm bút toán nào có ngày trong tháng đó.
-- Điều chỉnh về sau đi vào kỳ kế tiếp (ứng dụng tự dời ngày bút toán đảo khi huỷ).
CREATE FUNCTION journal_period_open() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "PeriodClosing"
    WHERE status = 'CLOSED'
      AND year = EXTRACT(YEAR FROM NEW."date")::int
      AND month = EXTRACT(MONTH FROM NEW."date")::int
  ) THEN
    RAISE EXCEPTION 'Kỳ %/% đã đóng sổ — ghi bút toán vào kỳ đang mở',
      EXTRACT(MONTH FROM NEW."date")::int, EXTRACT(YEAR FROM NEW."date")::int;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER journal_period_locked BEFORE INSERT ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION journal_period_open();

CREATE TRIGGER no_delete_period_closing BEFORE DELETE ON "PeriodClosing" FOR EACH ROW EXECUTE FUNCTION forbid_delete();

ALTER TABLE "PeriodClosing" ADD CONSTRAINT period_closing_month CHECK (month BETWEEN 1 AND 12);
ALTER TABLE "AllocationRun" ADD CONSTRAINT allocation_run_month CHECK (month BETWEEN 1 AND 12);
ALTER TABLE "Budget" ADD CONSTRAINT budget_month CHECK (month BETWEEN 1 AND 12 AND "amountVnd" >= 0);
ALTER TABLE "AllocationRule" ADD CONSTRAINT allocation_basis CHECK (basis IN ('REVENUE', 'HEADCOUNT', 'EQUAL') AND dimension IN ('SHOP'));
ALTER TABLE "TaxObligation" ADD CONSTRAINT tax_amounts CHECK ("amountVnd" > 0 AND "paidVnd" >= 0 AND "paidVnd" <= "amountVnd");
ALTER TABLE "ArInvoice" ADD CONSTRAINT ar_amounts CHECK ("amountVnd" > 0 AND "paidVnd" >= 0 AND "paidVnd" <= "amountVnd" AND "dueDate" >= "issueDate");
