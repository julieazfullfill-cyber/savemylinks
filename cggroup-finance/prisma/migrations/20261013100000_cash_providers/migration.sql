-- Nhóm tài khoản tiền (Payoneer, Airwallex, PingPong…) — tài khoản tiền thuộc một nhóm, nhận diện bằng email.

-- 1. Tài khoản kế toán cho nhóm mới
INSERT INTO "Account" ("code", "name", "type") VALUES
  ('107', 'Payoneer', 'ASSET'),
  ('108', 'PingPong', 'ASSET')
ON CONFLICT ("code") DO NOTHING;

-- 2. Bảng nhóm
CREATE TABLE "CashProvider" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "glAccount" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "CashProvider_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CashProvider_code_key" ON "CashProvider"("code");

-- 3. Nhóm khởi tạo (id cố định để gán tài khoản có sẵn bên dưới)
INSERT INTO "CashProvider" ("id", "code", "name", "kind", "glAccount") VALUES
  ('prov_payoneer',  'PAYONEER',  'Payoneer',        'EWALLET',  '107'),
  ('prov_airwallex', 'AIRWALLEX', 'Airwallex',       'EWALLET',  '103'),
  ('prov_pingpong',  'PINGPONG',  'PingPong',        'EWALLET',  '108'),
  ('prov_wealify',   'WEALIFY',   'Wealify',         'EWALLET',  '105'),
  ('prov_bank',      'NGAN_HANG', 'Ngân hàng',       'BANK',     '102'),
  ('prov_cash',      'TIEN_MAT',  'Tiền mặt',        'CASH',     '101'),
  ('prov_platform',  'SAN',       'Số dư trên sàn',  'PLATFORM', '111');

-- 4. Cột mới trên CashAccount, gán nhóm cho tài khoản đã có rồi mới bắt buộc
ALTER TABLE "CashAccount" ADD COLUMN "providerId" TEXT;
ALTER TABLE "CashAccount" ADD COLUMN "email" TEXT;

UPDATE "CashAccount" SET "providerId" = CASE
  WHEN "code" IN ('AWHK', 'AWVN') THEN 'prov_airwallex'
  WHEN "code" = 'WEALIFY' THEN 'prov_wealify'
  WHEN "kind" = 'CASH' THEN 'prov_cash'
  WHEN "kind" = 'PLATFORM' THEN 'prov_platform'
  WHEN "kind" = 'BANK' THEN 'prov_bank'
  ELSE 'prov_bank'
END;

ALTER TABLE "CashAccount" ALTER COLUMN "providerId" SET NOT NULL;
CREATE UNIQUE INDEX "CashAccount_providerId_email_key" ON "CashAccount"("providerId", "email");
ALTER TABLE "CashAccount" ADD CONSTRAINT "CashAccount_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "CashProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
