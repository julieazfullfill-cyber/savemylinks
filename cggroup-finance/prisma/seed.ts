import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { accounts, cashAccounts, expenseCategories, seedCatalog, suppliers } from "./seed-data";

const db = new PrismaClient();

async function main() {
  await seedCatalog(db);

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
