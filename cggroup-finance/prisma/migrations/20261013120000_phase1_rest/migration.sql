-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "journalId" TEXT,
ADD COLUMN     "rejectedReason" TEXT;

-- AlterTable
ALTER TABLE "PayrollPeriod" ADD COLUMN     "bonusOverrideAt" TIMESTAMP(3),
ADD COLUMN     "bonusOverrideBy" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SupplierBill" ADD COLUMN     "accountCode" TEXT NOT NULL DEFAULT '501',
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "journalId" TEXT;

-- CreateTable
CREATE TABLE "BillPayment" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "cashTxnId" TEXT NOT NULL,
    "amountVnd" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastSnapshot" (
    "id" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "scenario" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdjustment" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "perfPayVnd" BIGINT NOT NULL DEFAULT 0,
    "penaltyVnd" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillPayment_cashTxnId_key" ON "BillPayment"("cashTxnId");

-- CreateIndex
CREATE INDEX "BillPayment_billId_idx" ON "BillPayment"("billId");

-- CreateIndex
CREATE INDEX "ForecastSnapshot_weekStart_idx" ON "ForecastSnapshot"("weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollAdjustment_periodId_employeeId_key" ON "PayrollAdjustment"("periodId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_journalId_key" ON "Expense"("journalId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBill_journalId_key" ON "SupplierBill"("journalId");

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_billId_fkey" FOREIGN KEY ("billId") REFERENCES "SupplierBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Ràng buộc bổ sung
ALTER TABLE "SupplierBill" ADD CONSTRAINT supplier_bill_paid_le_amount CHECK ("paidVnd" <= "amountVnd");
ALTER TABLE "SupplierBill" ADD CONSTRAINT supplier_bill_status CHECK ("status" IN ('OPEN', 'PARTIAL', 'PAID'));
ALTER TABLE "BillPayment" ADD CONSTRAINT bill_payment_positive CHECK ("amountVnd" > 0);
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT payroll_adjustment_nonneg CHECK ("perfPayVnd" >= 0 AND "penaltyVnd" >= 0);
ALTER TABLE "AccountBalance" ADD CONSTRAINT account_balance_reserved CHECK ("reserved" >= 0);
CREATE TRIGGER no_delete_bill_payment BEFORE DELETE ON "BillPayment" FOR EACH ROW EXECUTE FUNCTION forbid_delete();
