# CGGroup — Tài chính, nhân sự, shop & đơn hàng

Xây theo đặc tả:
- Giai đoạn 1 (tài chính): https://claude.ai/artifact/EtgCxATpUvTUtKCpJEghnW
- Giai đoạn 2 (nhân sự, chấm công, lương, KPI): https://claude.ai/artifact/7sjsZZxEwv4q2PGCoGbo1i
- Giai đoạn 3 (shop, nhà cung cấp, đơn hàng): https://claude.ai/artifact/D2kfxhyzcpapDHUB3G1JEx

Next.js 15 (App Router, server actions) · Prisma 6 · PostgreSQL 16 · Tailwind 4 · Vitest.
**Cả 23 màn hình của ba giai đoạn đã làm xong.**

## Chạy

```bash
npm install
cp .env.example .env          # DATABASE_URL + AUTH_SECRET (≥ 32 ký tự)
npm run db:migrate            # bảng + trigger/chốt chặn
npm run db:seed               # danh mục GĐ1 + GĐ2 + admin
npm run dev                   # http://localhost:3000
```

Admin mặc định `admin@cggroup.local` / `doi-mat-khau-ngay` — **đổi ngay** ở màn 8 → Người dùng.
Máy dev: Postgres `F:\pgdev16`, port 5433; role/database `cggroup` / `cggroup_finance` (dev), `cggroup_finance_test` (test).

| Lệnh | Làm gì |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run db:migrate` / `db:deploy` / `db:seed` | Prisma (seed idempotent, không ghi đè số đã sửa tay) |
| `npm test` | Toàn bộ test (unit + DB). Mỗi file `*.db.test.ts` có schema Postgres riêng, xong thì xoá |
| `npm run test:unit` | Chỉ test thuần, không cần DB |
| `npm run payroll:selftest` | Self-test lương tháng 8 (đặc tả GĐ2 mục 09) — phải in `OK` |
| `npm run phase3:selftest` | Self-test GĐ3 tháng 8 (biên lãi, import, payout, cảnh báo) — phải in `OK` |
| `npm run typecheck` / `lint` | |
| `scripts/backup.ps1` | Sao lưu `pg_dump` vào `backups/`, giữ 30 bản. `-Register` để chạy 23:30 hằng ngày |
| `scripts/restore-test.ps1` | Khôi phục bản mới nhất vào DB tạm, so số dòng mọi bảng, xoá DB tạm |
| `scripts/demo-data.ts` | Dữ liệu mẫu đầy đủ — chỉ chạy được khi DATABASE_URL có chữ `demo`/`test` |

## Màn hình

| # | Màn | Ai dùng | Ghi chú |
|---|---|---|---|
| 1 | Tổng quan tiền | Admin, Quản lý | Tổng khả dụng quy VND, thu/chi 30 ngày, biểu đồ 90 ngày, 3 cảnh báo nặng nhất, số dư theo nhóm → tài khoản |
| 2 | Sổ quỹ | Admin, Kế toán | Chi / Thu từ shop (kênh → shop) / Thu khác / Số dư đầu kỳ; tỷ giá; huỷ = bút toán ngược; chứng từ; **nhập từ sheet 1a** (`/so-quy/nhap`) |
| 3 | Chi phí & duyệt chi | Mọi người | Đề nghị → duyệt (Nợ hạng mục / Có 201) → chi (Nợ 201); ngân sách tháng |
| 4 | Công nợ NCC | Admin, Kế toán | Hoá đơn (Nợ chi phí / Có 201), tuổi nợ, trả từng phần, tất toán chênh tỷ giá (701) |
| 5 | Chốt số dư | Admin, Kế toán | Số thật cuối ngày (khả dụng, bị giam, ngày về) so với sổ quỹ |
| 6 | Dự báo 13 tuần | Admin, Quản lý | Dữ liệu thật + đòn bẩy kịch bản, ngưỡng tối thiểu, snapshot + độ lệch |
| 7 | P&L quản trị | Admin, Quản lý, Kế toán | Từ sổ cái theo tháng; nạp & đối chiếu P&L Excel T4–T10 |
| 8 | Danh mục & người dùng | Admin | TK kế toán, nhóm TK tiền, TK tiền (email), hạng mục, NCC, shop (5 kênh), pháp nhân, người dùng |
| 9 | Hồ sơ nhân sự | Admin, Quản lý | |
| 10 | Hợp đồng & lương | Admin, Quản lý | Tăng lương = hợp đồng mới; tra lương bất kỳ tháng nào |
| 11 | Lưới chấm công | Admin, Quản lý | 1 / ½ / 0, điền đủ công, ngày lễ; khoá khi kỳ lương đã duyệt |
| 12 | Nghỉ phép | Mọi người | Nhân viên tự gửi đơn (cần gắn tài khoản ở màn 9), duyệt trừ phép |
| 13 | Kỳ lương | Admin, Kế toán, Quản lý | Nháp → Tính → Duyệt (bút toán) → Chi (Nợ 202) → Khoá; nộp BHXH (203) / thuế (204) |
| 14 | Phiếu lương | Mọi người | In được; nhân viên chỉ thấy phiếu của mình |
| 15 | KPI & thưởng | Admin, Quản lý | Tiền về (gợi ý từ Sổ quỹ) − FF − chi phí chung phân bổ; bậc thưởng; phê duyệt vượt cấp |
| 16 | Danh mục shop | Admin, Quản lý, Kế toán | Bắt buộc pháp nhân + tài khoản nhận tiền; đổi trạng thái ghi lịch sử; nghĩa vụ pháp nhân (vào dự báo) |
| 17 | Bản đồ tập trung | Admin, Quản lý, Kế toán | Tỷ trọng tiền thu theo tài khoản nhận, đỏ khi > 40% |
| 18 | Sức khoẻ shop | Admin, Quản lý | Lịch sử trạng thái, số lần sự cố theo kênh / người phụ trách |
| 19 | NCC & bảng giá | Admin, Quản lý, Kế toán | Điều khoản thanh toán, bảng giá theo thời kỳ, so sánh giá, thực trả vs bảng giá |
| 20 | Import đơn hàng | Admin, Kế toán | CSV 5 sàn, xem trước, cột khớp/thiếu, lỗi theo dòng; nạp đơn fulfill từ NCC |
| 21 | Đơn hàng | Admin, Kế toán, Quản lý | Lọc shop/kênh/tháng/đơn lỗ/chưa ghép; chi tiết đơn, ghép fulfill, hoàn tiền, biên lãi |
| 22 | Đối soát payout | Admin, Kế toán | Payout + dòng, ghép với đơn (ngưỡng lệch 1%), ghi tiền về vào Sổ quỹ |
| 23 | Biên lãi theo shop | Admin, Quản lý, Kế toán | Xếp hạng kênh / shop / design sau phân bổ chi phí chung, điểm hoà vốn |

## Sổ kép — mỗi nghiệp vụ ghi gì

| Nghiệp vụ | Nợ | Có | Nguồn |
|---|---|---|---|
| Số dư đầu kỳ | TK tiền | 301 | OPENING |
| Thu từ shop | TK tiền | 401 Etsy · 402 Amazon · 403 TikTok · 404 Website · 405 Walmart | CASH_TXN |
| Thu khác / chi thẳng | TK tiền / TK hạng mục | 409 / TK tiền | CASH_TXN |
| Hoá đơn NCC | TK chi phí (mặc định 501) | 201 | BILL |
| Trả NCC | 201 | TK tiền | BILL_PAYMENT |
| Duyệt đề nghị chi | TK hạng mục | 201 | EXPENSE |
| Chi đề nghị | 201 | TK tiền | EXPENSE_PAYMENT |
| Chênh tỷ giá khi tất toán | 201 / 701 | 701 / 201 | ADJUST |
| Duyệt kỳ lương | 601 (+ 602 BHXH công ty) | 202 · 203 · 204 · 702 (phạt) | PAYROLL |
| Chi lương / nộp BHXH / thuế | 202 / 203 / 204 | TK tiền | PAYROLL_PAYMENT |

Tài khoản tiền: Tiền mặt 101, Ngân hàng 102, Airwallex 103/104, Wealify 105, khác 106, Payoneer 107, PingPong 108, số dư trên sàn 111.

## Chốt chặn ở database (trigger / CHECK)

- Tổng nợ = tổng có mỗi bút toán (`DEFERRABLE INITIALLY DEFERRED`); mỗi dòng đúng một phía.
- Không xoá `CashTxn`, `JournalEntry`, `JournalLine`, `AuditLog`, `BillPayment`; không sửa dòng bút toán, AuditLog.
- Hợp đồng không sửa số tiền, không xoá, không chồng thời gian (EXCLUDE gist).
- Chấm công chỉ 0 / 0,5 / 1; dòng lương khoá khi kỳ APPROVED; kỳ CLOSED bất biến.
- Shop thuộc 1 trong 5 kênh; hoá đơn không trả quá số nợ.
- Huỷ giao dịch tiền (ở Sổ quỹ) tự gỡ khỏi hoá đơn NCC / đề nghị chi / kỳ lương đã dùng nó.

## Chỗ lệch / bổ sung so với đặc tả

**GĐ1**
- Đăng nhập email + mật khẩu (bcrypt, cookie JWT) thay Supabase Auth; chứng từ lưu `./uploads` (`UPLOAD_DIR`) thay Supabase Storage.
- `ExpenseCategory.dueDay`, `budgetVnd` — cho dự báo "rơi đúng tuần" và cảnh báo vượt ngân sách.
- Đặc tả ghi 35 tài khoản nhưng bảng có 41; thêm **405 Doanh thu Walmart**, **107 Payoneer**, **108 PingPong** → 44.
- **5 kênh bán** cố định (`src/lib/channels.ts`); **nhóm tài khoản tiền** (`CashProvider`) tạo được ở màn 8, tài khoản tiền nhận diện bằng email.
- Số dư đầu kỳ đối ứng **301 Vốn chủ sở hữu** — cần kế toán xác nhận.
- Đề nghị chi: ghi nhận chi phí khi **duyệt** (Nợ hạng mục / Có 201), không phải khi chi. Khoản đã trả thì nhập thẳng ở Sổ quỹ.
- Dự báo: giá vốn tính trên doanh số đều theo tuần (không theo payout), thu nhập tay nhân độ chắc chắn, chi luôn đủ 100%; lương lấy từ kỳ lương đã duyệt gần nhất thay ngân sách LUONG/BHXH.
- Chuyển tiền nội bộ giữa hai tài khoản (Airwallex → Bank): tạm nhập hai dòng Chi/Thu khác.

**GĐ2**
- Phép nhân tỷ lệ (ngày công, BHXH) dùng BigInt; self-test tháng 8 khớp từng đồng.
- `Holiday.date` là `@db.Date`. Bút toán lương có thêm Có 702 cho khoản phạt (đặc tả sẽ lệch đúng bằng số phạt).
- Bổ sung `PayrollAdjustment` (lương hiệu quả, phạt), `PayrollPeriod.bonusOverrideBy/paidCashTxnId`.
- Thực nhận âm (thiếu chấm công) → kỳ lương báo lỗi kèm tên, không tính.
- `bonusGate` khi chưa nhập lợi nhuận kỳ: giữ thưởng. Vai trò HR = Admin + Quản lý.
- Ngày tính lương = công chấm + phép có lương + lễ có lương (T2–T7), hợp đồng lấy theo ngày làm cuối trong tháng.

**GĐ3**
- Đơn hàng là dữ liệu **phân tích**, không ghi sổ cái: doanh thu vào sổ khi tiền về (payout → “Thu từ shop”), tránh ghi hai lần. Sổ kép đầy đủ theo đơn: GĐ4.
- Thêm **Walmart** (bảng giá payout và tên cột CSV — cần đối chiếu file/tài khoản thật).
- `Shop.payoutAccountId`, `Payout.shopId`, `PayoutLine.externalOrderId`, `FulfillmentOrder.sku`; tab Shop ở màn 8 chuyển sang màn 16; giá trị trạng thái cũ PAUSED → UNDER_REVIEW.
- Chi phí cố định (~19.800 USD trong đặc tả) **lấy từ sổ cái** (TK 60x mỗi tháng, quy USD cuối tháng), không gõ tay.
- Đơn CSV nhiều dòng sản phẩm được **gộp** thành nhiều mặt hàng (cột cấp mặt hàng cộng dồn, cột cấp đơn lấy một lần).
- Đối soát chấp nhận lệch ≤ 1% net; dự báo thêm cột **Đơn chờ về** (đơn đã bán chưa vào payout, theo lịch payout thật); kênh có dữ liệu đơn thì doanh thu trung bình chỉ tính cho đơn bán sau ngày bắt đầu.
- Bảng giá NCC theo thời kỳ như hợp đồng lương (giá mới đóng giá cũ, DB chặn chồng thời gian). Design / sản phẩm / SKU khai ở màn 8.
- Email tóm tắt buổi sáng chưa làm — cảnh báo GĐ3 hiện ở màn 1 mỗi lần mở.

## Cần kế toán xác nhận

`PayrollSetting`: `pit` (11.000.000 / 4.400.000 / 5–35%), `insurance` (NLĐ 10,5% · công ty 21,5%), `mealExemptCap` (730.000 đ).
Trần lương đóng BHXH chưa áp dụng. Đối ứng số dư đầu kỳ (301). Bậc thưởng KPI (màn 15).

## Cấu trúc

```
prisma/          schema, migrations (init, ledger_integrity, phase2_*, shop_channel, cash_providers, …), seed
src/lib/         money, dates, ledger (sổ kép), voids, channels, cash-accounts, payables, expenses, closing,
                 overview, forecast(+data), pnl(+data), import-1a, attachments,
                 pit, payroll, kpi, payroll-journal, payroll-settings, payroll-service, kpi-service, attendance, hr
src/app/(app)/   một thư mục mỗi màn hình (page.tsx + actions.ts)
scripts/         payroll-selftest, demo-data, backup.ps1, restore-test.ps1
tests/           *.test.ts (thuần) và *.db.test.ts (Postgres thật)
```
