-- GĐ4: thêm cách chia theo giá vốn fulfillment của shop (đơn fulfill GĐ3).
ALTER TABLE "AllocationRule" DROP CONSTRAINT allocation_basis;
ALTER TABLE "AllocationRule" ADD CONSTRAINT allocation_basis CHECK (basis IN ('REVENUE', 'HEADCOUNT', 'EQUAL', 'FF_COST') AND dimension IN ('SHOP'));
