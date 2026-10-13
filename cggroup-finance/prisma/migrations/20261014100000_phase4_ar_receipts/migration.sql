-- CreateTable
CREATE TABLE "ArReceipt" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "cashTxnId" TEXT NOT NULL,
    "amountVnd" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArReceipt_cashTxnId_key" ON "ArReceipt"("cashTxnId");

-- AddForeignKey
ALTER TABLE "ArReceipt" ADD CONSTRAINT "ArReceipt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "ArInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER no_delete_ar_receipt BEFORE DELETE ON "ArReceipt" FOR EACH ROW EXECUTE FUNCTION forbid_delete();
