import { PrismaClient } from "@prisma/client";

// Một PrismaClient cho cả tiến trình — tránh mở thêm pool mỗi lần hot-reload ở dev.
const g = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** JSON.stringify an toàn với BigInt/Decimal (cho AuditLog và trả về client). */
export function toJsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}
