// Đưa danh mục thật từ seed-data/*.csv vào VÙNG CHỜ CHỐT (bảng ImportRow, màn 30 "Nhập dữ liệu ban đầu").
// Dòng còn trống vẫn vào — điền nốt trên web, bấm "Chốt" thì mới ghi vào bảng thật và khoá dòng.
// Dòng đã có trong vùng chờ (đang sửa hoặc đã chốt) giữ nguyên: chạy lại không đè chỗ đã sửa trên web.
//
//   npm run import:seed                         chạy thử — không ghi gì
//   npm run import:seed -- --apply              ghi vào vùng chờ
//   npm run import:seed -- --dir <thư mục CSV>  (mặc định ./seed-data)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { CSV_FILE, KIND_VI, KINDS, stageRows, validate, type CsvRow } from "../src/lib/import-staging";
import { parseCsv } from "../src/lib/order-import";

const db = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const dirArg = process.argv.indexOf("--dir");
const DIR = dirArg > 0 ? process.argv[dirArg + 1] : join(process.cwd(), "seed-data");

function load(name: string): CsvRow[] {
  const p = join(DIR, name);
  if (!existsSync(p)) {
    console.log(`  (không thấy ${name}, bỏ qua)`);
    return [];
  }
  const [head, ...body] = parseCsv(readFileSync(p, "utf8"));
  if (!head) return [];
  const h = head.map((x) => x.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])));
}

class DryRun extends Error {}

async function main() {
  console.log(APPLY ? ">> GHI VÀO VÙNG CHỜ CHỐT\n" : ">> CHẠY THỬ — không ghi gì\n");
  console.log(`Thư mục CSV: ${DIR}\n`);
  const lines: string[] = [];
  try {
    await db.$transaction(
      async (tx) => {
        for (const kind of KINDS) {
          const rows = load(CSV_FILE[kind]);
          const r = await stageRows(tx, kind, rows, "import-seed");
          // kiểm đúng dữ liệu đang nằm trong vùng chờ (đã gợi ý sẵn nhóm tài khoản, đã sửa trên web…)
          const staged = await tx.importRow.findMany({ where: { kind, status: "DRAFT" }, orderBy: { createdAt: "asc" } });
          const locked = await tx.importRow.count({ where: { kind, status: "LOCKED" } });
          const incomplete = staged.map((s) => ({ key: s.key, errs: validate(kind, s.data as Record<string, string>) })).filter((s) => s.errs.length);
          lines.push(
            `${KIND_VI[kind].padEnd(15)}: ${r.added} dòng mới, ${r.kept} đã có (giữ nguyên) · chờ chốt ${staged.length} (đủ ${staged.length - incomplete.length}, còn thiếu ${incomplete.length}) · đã chốt ${locked}`,
          );
          const byErr = new Map<string, string[]>();
          for (const s of incomplete) byErr.set(s.errs.join("; "), [...(byErr.get(s.errs.join("; ")) ?? []), s.key]);
          for (const [e, keys] of byErr) lines.push(`    ${e}: ${keys.join(", ")}`);
        }
        if (!APPLY) throw new DryRun();
      },
      { timeout: 120_000 },
    );
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  console.log(lines.join("\n"));
  console.log(APPLY ? "\nXong. Mở màn 30 \"Nhập dữ liệu ban đầu\" để điền nốt và chốt." : "\n(Chạy thử — chưa ghi gì. Thêm --apply để đưa vào vùng chờ.)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
