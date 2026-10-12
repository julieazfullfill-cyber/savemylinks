import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { accounts, cashAccounts, expenseCategories, seedCatalog, suppliers } from "./seed-data";
import { seedPhase2 } from "./seed-phase2";

const db = new PrismaClient();

async function main() {
  await seedCatalog(db);
  const p2 = await seedPhase2(db);
  console.log(`GĐ2: ${p2.departments} phòng ban, ${p2.positions} chức danh, ${p2.leaveTypes} loại phép, ${p2.bonusTiers} bậc thưởng`);

  // Admin đầu tiên. Đổi mật khẩu ngay sau lần đăng nhập đầu (màn hình Danh mục → Người dùng).
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@cggroup.local";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "doi-mat-khau-ngay";
  const existing = await db.user.findUnique({ where: { email } });
  if (!existing) {
    await db.user.create({
      data: { email, name: "Admin", role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) },
    });
    console.log(`Tạo admin ${email} (mật khẩu từ SEED_ADMIN_PASSWORD hoặc mặc định)`);
  }

  console.log(
    `Seed xong: ${accounts.length} tài khoản kế toán, ${cashAccounts.length} tài khoản tiền, ` +
      `${suppliers.length} nhà cung cấp, ${expenseCategories.length} hạng mục chi phí`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
