-- AlterTable
ALTER TABLE "PayrollPeriod" ADD COLUMN     "paidCashTxnId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_paidCashTxnId_key" ON "PayrollPeriod"("paidCashTxnId");

