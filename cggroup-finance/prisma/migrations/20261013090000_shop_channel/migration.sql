-- Shop thuộc đúng một trong 5 kênh bán (khớp src/lib/channels.ts).
-- Tiền thu từ shop ghi Có vào tài khoản doanh thu của kênh: Etsy 401, Amazon 402,
-- TikTok 403, Website 404, Walmart 405.
INSERT INTO "Account" ("code", "name", "type") VALUES ('405', 'Doanh thu Walmart', 'REVENUE')
  ON CONFLICT ("code") DO NOTHING;

ALTER TABLE "Shop" ADD CONSTRAINT shop_channel
  CHECK ("channel" IN ('AMAZON', 'ETSY', 'WALMART', 'TIKTOK', 'WEBSITE'));
