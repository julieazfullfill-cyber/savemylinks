-- CreateEnum
CREATE TYPE "FulfillStatus" AS ENUM ('PENDING', 'SUBMITTED', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'PROCESSING', 'FULFILLED', 'DELIVERED', 'CANCELLED', 'REFUNDED');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "payoutAccountId" TEXT;

-- CreateTable
CREATE TABLE "Design" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "niche" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Design_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "designId" TEXT,
    "type" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "size" TEXT,
    "color" TEXT,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "orderedAt" DATE NOT NULL,
    "country" TEXT,
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "grossUsd" DECIMAL(12,2) NOT NULL,
    "discountUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shippingChargedUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "platformFeeUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netUsd" DECIMAL(12,2) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "importBatchId" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "variantId" TEXT,
    "sku" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unitPriceUsd" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderCost" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ffCostUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shipCostUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "designCostUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "adsCostUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "overheadUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "OrderCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "refundedAt" DATE NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "externalId" TEXT,
    "sku" TEXT,
    "submittedAt" DATE,
    "status" "FulfillStatus" NOT NULL DEFAULT 'PENDING',
    "costUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shipUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "listedCostUsd" DECIMAL(12,2),
    "trackingNo" TEXT,

    CONSTRAINT "FulfillmentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPrice" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "priceUsd" DECIMAL(12,2) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,

    CONSTRAINT "SupplierPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "shopId" TEXT,
    "channel" TEXT NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "grossUsd" DECIMAL(12,2) NOT NULL,
    "feeUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netUsd" DECIMAL(12,2) NOT NULL,
    "arrivedAt" DATE,
    "cashTxnId" TEXT,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutLine" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "orderId" TEXT,
    "externalOrderId" TEXT,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ORDER',

    CONSTRAINT "PayoutLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopHealthEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "at" DATE NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,

    CONSTRAINT "ShopHealthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityFiling" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "amountVnd" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "completedAt" DATE,

    CONSTRAINT "EntityFiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "okCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "importedBy" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Design_code_key" ON "Design"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_sku_key" ON "Variant"("sku");

-- CreateIndex
CREATE INDEX "Order_orderedAt_idx" ON "Order"("orderedAt");

-- CreateIndex
CREATE INDEX "Order_shopId_orderedAt_idx" ON "Order"("shopId", "orderedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopId_externalId_key" ON "Order"("shopId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCost_orderId_key" ON "OrderCost"("orderId");

-- CreateIndex
CREATE INDEX "FulfillmentOrder_supplierId_submittedAt_idx" ON "FulfillmentOrder"("supplierId", "submittedAt");

-- CreateIndex
CREATE INDEX "FulfillmentOrder_status_idx" ON "FulfillmentOrder"("status");

-- CreateIndex
CREATE INDEX "SupplierPrice_supplierId_sku_effectiveFrom_idx" ON "SupplierPrice"("supplierId", "sku", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_cashTxnId_key" ON "Payout"("cashTxnId");

-- CreateIndex
CREATE INDEX "Payout_arrivedAt_idx" ON "Payout"("arrivedAt");

-- CreateIndex
CREATE INDEX "ShopHealthEvent_shopId_at_idx" ON "ShopHealthEvent"("shopId", "at");

-- CreateIndex
CREATE INDEX "EntityFiling_dueDate_status_idx" ON "EntityFiling"("dueDate", "status");

-- AddForeignKey
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_payoutAccountId_fkey" FOREIGN KEY ("payoutAccountId") REFERENCES "CashAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCost" ADD CONSTRAINT "OrderCost_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentOrder" ADD CONSTRAINT "FulfillmentOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentOrder" ADD CONSTRAINT "FulfillmentOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPrice" ADD CONSTRAINT "SupplierPrice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutLine" ADD CONSTRAINT "PayoutLine_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutLine" ADD CONSTRAINT "PayoutLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopHealthEvent" ADD CONSTRAINT "ShopHealthEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityFiling" ADD CONSTRAINT "EntityFiling_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------- chốt chặn GĐ3
-- Trạng thái shop (đặc tả GĐ3 mục 03). Giá trị cũ PAUSED (GĐ1) → UNDER_REVIEW.
UPDATE "Shop" SET "status" = 'UNDER_REVIEW' WHERE "status" = 'PAUSED';
ALTER TABLE "Shop" ADD CONSTRAINT shop_status
  CHECK ("status" IN ('ACTIVE', 'UNDER_REVIEW', 'SUSPENDED', 'DEACTIVATED', 'CLOSED'));

-- Bảng giá: một NCC + SKU không có hai giá hiệu lực chồng nhau.
ALTER TABLE "SupplierPrice" ADD CONSTRAINT supplier_price_positive CHECK ("priceUsd" > 0 AND ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"));
ALTER TABLE "SupplierPrice" ADD CONSTRAINT supplier_price_no_overlap EXCLUDE USING gist (
  "supplierId" WITH =, "sku" WITH =, daterange("effectiveFrom", "effectiveTo", '[]') WITH &&
);

ALTER TABLE "Order" ADD CONSTRAINT order_amounts CHECK (
  "grossUsd" >= 0 AND "discountUsd" >= 0 AND "shippingChargedUsd" >= 0 AND "platformFeeUsd" >= 0 AND "taxUsd" >= 0
);
ALTER TABLE "OrderItem" ADD CONSTRAINT order_item_qty CHECK ("qty" > 0 AND "unitPriceUsd" >= 0);
ALTER TABLE "FulfillmentOrder" ADD CONSTRAINT fulfillment_amounts CHECK ("costUsd" >= 0 AND "shipUsd" >= 0);
ALTER TABLE "Refund" ADD CONSTRAINT refund_positive CHECK ("amountUsd" > 0);
ALTER TABLE "Payout" ADD CONSTRAINT payout_period CHECK ("periodTo" >= "periodFrom" AND "feeUsd" >= 0);
