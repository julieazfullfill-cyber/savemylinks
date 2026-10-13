// Test DB: mỗi file *.db.test.ts có một schema Postgres riêng trong DB test (.env.test),
// migrate deploy sẵn ở đây → các file không thấy dữ liệu của nhau. Chạy xong bỏ đúng các schema
// vừa tạo. Không reset/drop dữ liệu nào có sẵn.
//
// Mỗi file DB chọn schema của mình ở dòng đầu, trước khi Prisma kết nối:
//   vi.hoisted(() => { process.env.DATABASE_URL = process.env.TEST_DB_URL_LEDGER; });
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

export const envKeyFor = (file: string) => `TEST_DB_URL_${file.replace(/\.db\.test\.ts$/, "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

export default async function setup() {
  if (process.env.VITEST_UNIT) return; // npm run test:unit — không đụng DB
  const base = process.env.DATABASE_URL;
  if (!base || !/_test\b/.test(base)) throw new Error("DATABASE_URL của test phải trỏ tới DB *_test (xem .env.test)");

  const files = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".db.test.ts"));
  const stamp = Date.now();
  const schemas: string[] = [];
  for (const f of files) {
    const schema = `t_${stamp}_${f.replace(/\.db\.test\.ts$/, "").replace(/[^a-z0-9]/gi, "_")}`;
    const url = `${base}${base.includes("?") ? "&" : "?"}schema=${schema}`;
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
    process.env[envKeyFor(f)] = url;
    schemas.push(schema);
  }
  // File DB nào quên chọn schema sẽ trỏ vào schema không tồn tại và lỗi ngay, thay vì ghi vào DB khác.
  process.env.DATABASE_URL = `${base}${base.includes("?") ? "&" : "?"}schema=khong_chon_schema`;

  return async () => {
    const db = new PrismaClient({ datasourceUrl: base });
    for (const s of schemas) await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    await db.$disconnect();
  };
}
