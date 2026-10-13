// Job buổi sáng (GĐ4 tuần 4): quét toàn bộ cảnh báo, ghi lịch sử (màn 28), in bản tóm tắt.
// Chạy: npm run alerts:daily — đặt lịch bằng Task Scheduler / cron lúc 7:00 (xem README).
import { PrismaClient } from "@prisma/client";
import { LEVEL_OF, loadAllAlerts, syncAlertLog } from "../src/lib/alerts";
import { audit } from "../src/lib/audit";
import { fmtBizDate, todayVn } from "../src/lib/dates";

const db = new PrismaClient();

async function main() {
  const today = todayVn();
  const alerts = await loadAllAlerts(db, today);
  const r = await syncAlertLog(db, alerts);
  await audit(db, { actorId: "system", tableName: "AlertJob", recordId: fmtBizDate(today), action: "CREATE", after: r });

  const open = await db.alertLog.findMany({ where: { resolvedAt: null }, orderBy: [{ level: "desc" }, { firedAt: "asc" }] });
  console.log(`CGGroup — cảnh báo sáng ${fmtBizDate(today)}: ${open.length} đang mở (+${r.opened} mới, ${r.resolved} đã hết)`);
  for (const a of open) {
    const tag = a.level === LEVEL_OF.crit ? "!!" : a.level === LEVEL_OF.warn ? " !" : "  ";
    console.log(`${tag} ${a.title}${a.acknowledgedBy ? "" : "  [chưa ai nhận]"}`);
    console.log(`   ${a.detail}`);
  }
  if (!open.length) console.log("Không có gì bất thường.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
