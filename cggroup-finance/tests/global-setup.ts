// Mỗi lần chạy test dùng một schema Postgres mới trong DB test (.env.test):
// migrate deploy vào schema đó, chạy test, rồi bỏ đúng schema vừa tạo.
// Không reset/drop dữ liệu nào có sẵn.
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

export default async function setup() {
  if (process.env.VITEST_UNIT) return; // npm run test:unit — không đụng DB
  const base = process.env.DATABASE_URL;
  if (!base || !/_test\b/.test(base)) throw new Error("DATABASE_URL của test phải trỏ tới DB *_test (xem .env.test)");
  const schema = `t_${Date.now()}`;
  const url = `${base}${base.includes("?") ? "&" : "?"}schema=${schema}`;
  process.env.DATABASE_URL = url;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });

  return async () => {
    const db = new PrismaClient({ datasourceUrl: base });
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  };
}
