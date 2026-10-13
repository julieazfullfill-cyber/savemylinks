# CGGroup — Hệ thống tài chính & nhân sự

Xây theo đặc tả:
- Giai đoạn 1 (tài chính): https://claude.ai/artifact/EtgCxATpUvTUtKCpJEghnW
- Giai đoạn 2 (nhân sự, chấm công, lương, KPI): https://claude.ai/artifact/7sjsZZxEwv4q2PGCoGbo1i

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
- **Tiền thu chia theo 5 kênh** (`src/lib/channels.ts`): Amazon 402, Etsy 401, Walmart 405 (thêm mới), TikTok 403,
  Website 404. Mỗi shop thuộc một kênh (CHECK `shop_channel` ở DB). Sổ quỹ có 4 loại: Chi, **Thu từ shop**
  (bắt buộc chọn kênh → shop, Có doanh thu của kênh), Thu khác (409 — hoàn tiền NCC, góp vốn…), Số dư đầu kỳ (Có 301).
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

---

## Giai đoạn 2 — Nhân sự, chấm công, tiền lương

```bash
npm run db:migrate          # migration phase2_hr_payroll + phase2_integrity
npm run db:seed             # seed gồm cả GĐ2 (phòng ban, chức danh, loại phép, bậc thưởng, PayrollSetting)
npm run payroll:selftest    # phải in "OK — but toan can, tong ky bang tong cac dong."
```

| File | Nội dung |
|---|---|
| `prisma/schema.prisma` (cuối file) | 14 model GĐ2 — chỉ thêm, không sửa model GĐ1 |
| `prisma/migrations/…_phase2_integrity` | hợp đồng không sửa/xoá, không chồng thời gian; chấm công 0/0,5/1; dòng lương khoá khi kỳ APPROVED; kỳ CLOSED bất biến |
| `prisma/seed-phase2.ts` | danh mục GĐ2 + tham số `pit`, `insurance`, `mealExemptCap` |
| `src/lib/pit.ts` | thuế TNCN luỹ tiến |
| `src/lib/payroll.ts` | động cơ tính lương, `totalPayroll()` không nhận tham số tổng |
| `src/lib/kpi.ts` | KPI (trừ chi phí chung), bậc thưởng, `bonusGate()` |
| `src/lib/payroll-journal.ts` | bút toán lương 601/602 ↔ 202/203/204 |
| `src/lib/payroll-settings.ts` | đọc tham số từ `PayrollSetting`, báo key nào đang dùng giá trị khởi tạo |
| `src/lib/payroll-service.ts` | kỳ lương trên DB: tạo → tính → duyệt (sinh bút toán) |
| `src/lib/hr.ts`, `hr-forms.ts` | thêm hợp đồng (tự đóng hợp đồng cũ), parse form |
| `scripts/payroll-selftest.ts` | self-test số liệu tháng 8 (đặc tả mục 09) |
| `src/app/(app)/nhan-su`, `hop-dong` | màn 9 Hồ sơ nhân sự, màn 10 Hợp đồng & lương |

### Chỗ lệch / bổ sung so với đặc tả GĐ2

- **Tiền tính bằng BigInt**: `prorate` và BHXH trong đặc tả nhân `Number` — đổi sang BigInt theo quy ước GĐ1.
  Self-test tháng 8 ra đúng từng đồng như đặc tả (56.753.708 đ thực nhận, bút toán 76.893.333 đ) — có test khoá lại.
- **`Holiday.date`** dùng `@db.Date` thay vì `String` (quy ước 4 của GĐ1).
- **Bút toán có khoản phạt**: đặc tả bỏ qua `penaltyVnd` nên sẽ lệch đúng bằng số phạt. Thêm dòng Có 702 cho phần phạt.
- **`bonusGate` khi chưa nhập lợi nhuận kỳ** (`companyProfitVnd = null`): giữ thưởng lại, không chi.
- **Vai trò HR** chưa có trong enum GĐ1 → màn 9, 10, 11 dành cho ADMIN + QUAN_LY.
- **Ngày tính lương** = công chấm + phép có lương + lễ có lương (thứ Hai–thứ Bảy), tối đa ngày công chuẩn.
  Cột `workedDays` lưu công chấm, `leaveDays` lưu phép + lễ.
- **Hợp đồng áp cho kỳ** = hợp đồng hiệu lực vào ngày làm cuối của người đó trong tháng (tăng lương giữa tháng
  chưa chia hai mức — cần chính sách nếu muốn).
- **Thiếu hợp đồng → kỳ lương báo lỗi kèm tên người**, không bỏ qua (chặn đúng lỗi bỏ sót người tháng 8).
- Ngày công chuẩn nhập tay khi tạo kỳ; `suggestStandardDays` chỉ gợi ý (T2–T7 trừ lễ — tháng 8 ra 26, đặc tả dùng 24).
- Chưa seed ngày lễ — nhập khi làm màn 11.

### Cần kế toán xác nhận (đặc tả mục 12)

`PayrollSetting`: `pit` (11.000.000 / 4.400.000 / 5–35%), `insurance` (NLĐ 10,5% · công ty 21,5%),
`mealExemptCap` (730.000 đ). Seed không ghi đè giá trị đã sửa. Trần lương đóng BHXH chưa áp dụng.

### Tiến độ GĐ2

- [x] **Tuần 1** — schema + migration + chốt chặn DB, seed, màn 9 và 10
- [x] Lõi tuần 3–4: động cơ tính lương, thuế, KPI/cổng chặn, bút toán; service tính & duyệt kỳ (có test DB)
- [ ] Tuần 2 — màn 11 lưới chấm công, ngày lễ, màn 12 nghỉ phép + số dư phép
- [ ] Tuần 3 — màn 13 kỳ lương (UI 5 trạng thái, nhập lương hiệu quả/khấu trừ), đối chiếu Excel kỳ 12
- [ ] Tuần 4 — chi lương (PAID → CashTxn Nợ 202), khoá kỳ, màn 14 phiếu lương
- [ ] Tuần 5 — màn 15 KPI & thưởng, phê duyệt vượt cấp phần thưởng bị giữ, chạy song song Excel
