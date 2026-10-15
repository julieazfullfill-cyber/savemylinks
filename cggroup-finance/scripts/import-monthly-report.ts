// Đưa thu chi lịch sử từ "Team X/Profit/Tháng N Doanh thu chi phí team X.xlsx" vào vùng chờ (màn 31 "Đối chiếu thu chi").
// Chỉ đọc file — không sửa gì trên Drive. Chốt (ghi Sổ quỹ thật) làm trên web sau khi gắn shop / TK.
//
//   npm run import:report -- --dir "G:\My Drive\CGGroup Finance Report"            chạy thử
//   npm run import:report -- --dir "..." --apply                                    ghi vào vùng chờ
//   thêm --year 2026 --months 4-9   (mặc định), --replace để nạp lại tháng chưa chốt dòng nào
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseMonthlyReport } from "../src/lib/monthly-report";
import { sourceOf, stageReport } from "../src/lib/report-staging";

const db = new PrismaClient();
const arg = (k: string) => (process.argv.indexOf(k) > 0 ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const APPLY = process.argv.includes("--apply");
const REPLACE = process.argv.includes("--replace");
const DIR = arg("--dir");
const YEAR = Number(arg("--year") ?? 2026);
const [M0, M1] = (arg("--months") ?? "4-9").split("-").map(Number);

class DryRun extends Error {}

async function main() {
  if (!DIR || !existsSync(DIR)) throw new Error(`Không thấy thư mục --dir "${DIR ?? ""}"`);
  console.log(APPLY ? ">> GHI VÀO VÙNG CHỜ\n" : ">> CHẠY THỬ — không ghi gì\n");
  const files: { team: number; month: number; path: string }[] = [];
  for (const team of [1, 2, 3, 4]) {
    const dir = join(DIR, `Team ${team}`, "Profit");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = /^Tháng (\d+) Doanh thu chi phí team \d+\.xlsx$/i.exec(f.normalize("NFC"));
      if (m && Number(m[1]) >= M0 && Number(m[1]) <= (M1 ?? M0)) files.push({ team, month: Number(m[1]), path: join(dir, f) });
    }
  }
  files.sort((a, b) => a.team - b.team || a.month - b.month);
  const out: string[] = [];
  try {
    await db.$transaction(
      async (tx) => {
        for (const f of files) {
          const parsed = parseMonthlyReport(readFileSync(f.path), { year: YEAR, month: f.month });
          const r = await stageReport(tx, { team: f.team, year: YEAR, month: f.month, file: f.path, parsed, replace: REPLACE, actorId: "import-report" });
          out.push(`${sourceOf(f.team, YEAR, f.month)}: ${r.added ? `${r.added} dòng` : `đã có ${r.kept} dòng — giữ nguyên`} · tỷ giá ${parsed.fxRate ?? "?"}${parsed.warnings.length ? ` · ${parsed.warnings.length} cảnh báo` : ""}`);
          for (const w of parsed.warnings) out.push(`    ! ${w}`);
        }
        if (!APPLY) throw new DryRun();
      },
      { timeout: 300_000 },
    );
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  console.log(out.join("\n") || "Không thấy file nào.");
  console.log(APPLY ? '\nXong. Mở màn 31 "Đối chiếu thu chi" để gắn shop / tài khoản và chốt.' : "\n(Chạy thử — thêm --apply để ghi vào vùng chờ.)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
