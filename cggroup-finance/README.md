# CGGroup — Hệ thống tài chính (giai đoạn 1)

Xây theo đặc tả: https://claude.ai/artifact/EtgCxATpUvTUtKCpJEghnW

Next.js 15 (App Router) · Prisma 6 · PostgreSQL 16 · Tailwind 4 · Vitest.

## Chạy lần đầu

```bash
npm install
cp .env.example .env          # điền DATABASE_URL + AUTH_SECRET (≥ 32 ký tự)
npm run db:migrate            # tạo bảng + trigger cân bút toán
npm run db:seed               # danh mục + admin
npm run dev                   # http://localhost:3000
```

Admin mặc định: `admin@cggroup.local` / `doi-mat-khau-ngay` (hoặc đặt `SEED_ADMIN_EMAIL`,
`SEED_ADMIN_PASSWORD` trước khi seed). **Đổi mật khẩu ngay** ở Danh mục → Người dùng.

Máy dev hiện tại: Postgres ở `F:\pgdev16`, port **5433** (dùng chung với POD scanner, bật bằng
`scripts/autostart.ps1` bên đó). Project này có role/database riêng: `cggroup` /
`cggroup_finance` (dev) và `cggroup_finance_test` (test).

## Lệnh

| Lệnh | Làm gì |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:deploy` | `prisma migrate deploy` (production) |
| `npm run db:seed` | Seed danh mục (idempotent — chạy lại chỉ cập nhật tên) |
| `npm run test:unit` | Test thuần, không cần DB |
| `npm test` | Toàn bộ, gồm test DB. Mỗi lần chạy tạo một schema `t_<timestamp>` trong DB test, chạy xong thì bỏ schema đó |
| `npm run typecheck` / `lint` | |

## Cấu trúc

```
prisma/
  schema.prisma                 18 model theo mục 02
  migrations/…_init             bảng
  migrations/…_ledger_integrity trigger nợ = có, CHECK số dương, cấm DELETE/UPDATE sổ
  seed-data.ts, seed.ts         mục 03
src/lib/
  money.ts      BigInt minor unit, quy đổi VND, định dạng
  dates.ts      ngày nghiệp vụ (@db.Date, 00:00 UTC), giờ VN
  ledger.ts     postCashTxn / voidCashTxn — sinh JournalEntry cân + AuditLog
  forecast.ts   thuật toán dự báo 13 tuần (hàm thuần, mục 06)
  catalog.ts    cấu hình + parse form màn hình 8
  permissions.ts, session.ts, auth.ts   4 vai trò, JWT cookie, kiểm lại DB ở server
src/middleware.ts                       chặn route theo vai trò
src/app/(app)/danh-muc/[kind]           màn hình 8 — CRUD 7 danh mục
src/app/(app)/*                         màn hình 1–7: khung, ghi tuần dự kiến
tests/                                  money, forecast, catalog, ledger.db
```

## Quy ước bắt buộc được thực thi ở đâu

| Quy ước (mục 01) | Ứng dụng | Database |
|---|---|---|
| Tiền BigInt minor unit | `money.ts` không đi qua float | cột `BigInt` |
| amount + currency + amountVnd lưu cứng | `postCashTxn` tra `FxRate` gần nhất ≤ ngày giao dịch | — |
| Không xoá bản ghi tài chính | `voidCashTxn` = `voidedAt` + bút toán ngược (`reversalOf`) | trigger cấm DELETE `CashTxn`, `JournalEntry`, `JournalLine`, `AuditLog`; cấm UPDATE `JournalLine`, `AuditLog` |
| Nợ = có | `assertBalanced` | `journal_balanced` (DEFERRABLE INITIALLY DEFERRED) + CHECK mỗi dòng đúng một phía |
| Ngày nghiệp vụ tách khỏi timestamp | `parseBizDate`, `todayVn` | `@db.Date` |

## Chỗ lệch / bổ sung so với đặc tả

- `User.passwordHash` — đặc tả chưa nói cách đăng nhập. Dùng email + mật khẩu (bcrypt) và cookie JWT
  thay vì Supabase Auth để chạy được trên Postgres local. Đổi sang Supabase sau chỉ cần thay `session.ts`/`login`.
- `ExpenseCategory.dueDay`, `ExpenseCategory.budgetVnd` — dự báo cần biết khoản định kỳ đến hạn ngày nào
  và bao nhiêu ("rơi đúng tuần"), cảnh báo chi vượt ngân sách cũng cần số này. Điền ở màn hình 8.
- Bảng tài khoản trong đặc tả liệt kê **41** tài khoản (tiêu đề ghi 35) — seed đủ 41, rà lại hạn 18/10.
- Pháp nhân và shop chưa có trong đặc tả → chưa seed; nhập ở màn hình 8 (việc GĐ0 hạn 22/10).
- Giao dịch không gắn hạng mục: đối ứng mặc định 409 (thu) / 699 (chi).
- Dự báo: giá vốn tính từ doanh số đều theo tuần (không theo payout bị dồn); khoản thu nhập tay nhân
  `confidence`, khoản chi luôn tính đủ 100%; hoá đơn quá hạn dồn vào tuần 1.
- Phân quyền màn hình (Giám đốc = vai trò `QUAN_LY`) nằm ở `src/lib/permissions.ts`.

## Tiến độ theo kế hoạch 5 tuần

- [x] **Tuần 1** — dự án, schema + migration + trigger, seed, đăng nhập + 4 vai trò + middleware, màn hình 8
- [x] Lõi tuần 2: ghi/huỷ giao dịch tiền sinh bút toán + AuditLog (đã test với DB)
- [x] Lõi tuần 5: thuật toán dự báo 13 tuần (đã test)
- [ ] Tuần 2 — màn hình 2 Sổ quỹ, upload chứng từ, import sheet 1a
- [ ] Tuần 3 — màn hình 3, 4, 5, nhập tỷ giá
- [ ] Tuần 4 — màn hình 7 P&L, import LegacyPnl, màn hình 1
- [ ] Tuần 5 — màn hình 6 dự báo (loader DB + UI + snapshot), 4 cảnh báo, sao lưu
