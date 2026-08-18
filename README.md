# Etsy Shop Tracker

App theo dõi shop Etsy có phân quyền 2 vai trò:

- **User thường**: tab **"Tổng quan"** (mặc định khi vào) hiện tổng số shop, tổng số
  listing, số listing mới/đã gỡ **hôm nay** (cộng dồn qua mọi shop), và bảng shop theo
  niche. Tab "Shop của bạn" có thêm dropdown lọc theo niche. Đăng ký/đăng nhập, thêm
  link shop Etsy muốn theo dõi + gắn niche.
  Ngay khi thêm, server **tự động lấy dữ liệu ở nền** (không cần admin can thiệp) —
  dashboard hiện trạng thái "⏳ Đang chờ" → "🔄 Đang lấy thông tin..." → "✅ Đã cập
  nhật" (hoặc "❌ Lỗi" kèm nút Thử lại), tự cập nhật mỗi vài giây không cần refresh
  trang. Xem tên shop, địa điểm, rating, tổng lượt sale, và từng listing (ảnh
  thumbnail, tên, giá bằng USD quy đổi từ giá gốc + dự đoán listing bán chạy nhất
  dựa trên số review khi có). Grid listing có dropdown **sắp xếp theo số review từng
  sản phẩm** (tăng/giảm dần, sản phẩm chưa có dữ liệu review luôn xuống cuối) — số
  review này đến từ cơ chế "lấy review khi rảnh" ở admin, không phải lúc nào cũng có
  ngay từ lần scrape đầu. Mỗi lần cập nhật cũng hiện thêm: **số sale/review tăng
  thêm** so với lần cập nhật trước (badge "+N" cạnh Sales/Reviews), **so với ~7 ngày
  trước**, và **so với ~30 ngày trước** (2 dòng riêng, chỉ hiện khi đã có đủ lịch sử
  để so sánh) — cùng **thời gian shop đã hoạt động trên Etsy** (Etsy tự tính, ví dụ
  "9 months", "5 years"). Click vào 1 listing để phóng to ảnh + xem tên đầy đủ;
  nút nhỏ dưới mỗi listing dẫn thẳng tới trang gốc trên Etsy. Tab **"Báo cáo thay
  đổi"** liệt kê: shop nào có sản phẩm mới/sản phẩm bị gỡ so với lần lấy dữ liệu
  trước, và shop nào hiện không lấy được dữ liệu (đóng, nghỉ vacation, bị xoá khỏi
  Etsy...).
- **Admin** (1 tài khoản duy nhất): thấy hàng đợi các shop đang chờ/lỗi, có thể bấm
  "Chạy tự động" lại (dùng lại cơ chế tự động ở trên, thường thành công), hoặc — nếu
  vẫn bị chặn — tự mở link, F12 lấy HTML thủ công rồi dán vào để hoàn tất thay; xem
  xong cũng thấy luôn grid listing của shop đó (cùng dropdown sắp xếp theo số review
  như trên). Tab "Tất cả shop" nhóm theo user (số shop đang theo dõi + lần đăng nhập
  gần nhất mỗi người) và có dropdown **sắp xếp shop** theo số listing/sale/review,
  hoặc theo mức tăng sale/review so với lần trước / ~7 ngày / ~30 ngày. Tab **"Báo
  cáo thay đổi"** — như tab cùng tên bên user nhưng gộp **mọi shop của mọi user**
  (kèm email người thêm), để admin thấy được toàn bộ thay đổi trên hệ thống. Tab
  **"Quản lý User"** riêng — bảng thông tin cơ bản mọi user (email, ngày đăng ký,
  lần đăng nhập gần nhất, số shop), chỉ xem, không có hành động quản trị.
  Tab "Cài đặt" cho chỉnh **số cửa sổ Chrome thật chạy đồng thời trên server
  (1-100)**, **proxy riêng cho từng cửa sổ** (để trống = không dùng proxy),
  **lịch tự động lấy lại dữ liệu** các shop đã thêm từ trước (giờ cố định mỗi ngày,
  hoặc "tự động" — rảnh thì tự lấy shop cũ nhất), và **lấy review từng sản phẩm khi
  rảnh** (xem mục riêng bên dưới) — tất cả áp dụng ngay, không cần khởi động lại
  server.

## Hàng đợi lấy dữ liệu (concurrency)

Mọi lượt tự động lấy dữ liệu (user thêm shop mới, user bấm "Thử lại", admin bấm
"Chạy tự động") đều đi qua **cùng một worker pool** (`server/app/scrape_worker.py`)
thay vì mỗi request tự mở một cửa sổ Chrome riêng. Pool có N worker cố định (N =
`max_concurrent` trong Cài đặt), mỗi worker giữ 1 "cửa sổ" — lấy 1 shop_id từ hàng
đợi, mở Chrome thật với proxy được gán cho cửa sổ đó, xong mới lấy shop tiếp theo.
Để `max_concurrent = 1` thì đúng như yêu cầu: tuyệt đối tuần tự, không bao giờ 2 cửa
sổ Chrome mở cùng lúc. Đổi số lượng trong Cài đặt sẽ mở/đóng thêm worker ngay lập
tức (worker bị đóng vẫn làm nốt job đang chạy dở, không bị ngắt giữa chừng).

## Báo cáo thay đổi & lịch tự động lấy lại

Mỗi lần tự động scrape lại toàn bộ shop (không tính lần dán HTML thủ công, vì đó chỉ
là 1 trang), server so sánh danh sách listing mới lấy được với danh sách đang lưu
trong DB *trước khi ghi đè* — id nào xuất hiện lần đầu thì tính là "sản phẩm mới", id
nào từng có mà giờ mất thì tính là "sản phẩm đã gỡ" (`save_scraped_data` trong
`scrape_worker.py`). Bỏ qua ở lần scrape đầu tiên của mỗi shop (chưa có gì để so
sánh). Kết quả lưu vào `shops.last_added_listings`/`last_removed_listings` (đè lên
mỗi lần scrape mới — chỉ so với lần *ngay trước đó*, không phải lịch sử đầy đủ), user
xem ở tab "Báo cáo thay đổi".

Nếu trang shop load được (200) nhưng hiện banner "vacation"/"closed"/tương tự, hoặc
URL trả về 404 thẳng (khác với 403 DataDome), server đánh dấu
`shops.is_available = false` kèm `unavailable_reason`, và **không đụng vào** dữ liệu
listing đang có (shop có thể quay lại sau khi hết vacation) — xem
`detect_shop_unavailable` trong `scraper.py`.

Admin bật lịch tự động ở tab Cài đặt (`scheduler.py`, thread nền tự kiểm tra mỗi
60 giây): **giờ cố định** re-queue toàn bộ shop 1 lần/ngày; **tự động** thì bất cứ
lúc nào hàng đợi rảnh (không có shop nào đang `pending`/`scraping`) sẽ tự lấy lại 1
shop có `scraped_at` cũ nhất, **tối đa 1 lần/24h cho mỗi shop** — shop vừa lấy trong
24h qua bị bỏ qua dù đang là "cũ nhất" và hệ thống đang rảnh, để tránh việc chỉ có
vài shop thì bị scrape lặp lại liên tục mỗi phút. Giới hạn này chỉ áp dụng cho chế độ
**tự động**; không giới hạn nút "Thử lại"/"Chạy tự động" thủ công hay chế độ **giờ cố
định** (đều là hành động chủ động, luôn được thực hiện ngay). Shop đang `failed` cũng
bị bỏ qua ở chế độ tự động cùng lý do (tránh lặp vô hạn vào 1 shop luôn lỗi) — dùng
nút thủ công cho các shop đó.

Số sale/review **so với tuần/tháng trước** dựa trên bảng lịch sử
`shop_metric_snapshots` — mỗi lần scrape tự động thành công ghi thêm 1 dòng snapshot
(tổng sales/reviews tại thời điểm đó). Lúc hiển thị, server tìm snapshot **gần nhất
tính từ ~7/~30 ngày trước** (không phải đúng ranh giới lịch, vì lịch scrape không cố
định hằng ngày) rồi trừ cho số hiện tại. Nếu shop chưa có snapshot nào đủ cũ (mới
thêm gần đây), dòng so sánh tương ứng sẽ ẩn đi thay vì hiện "+0" gây hiểu nhầm.

## Lấy review từng sản phẩm khi rảnh

Etsy không còn hiện số review trên từng listing card ở trang chính của shop (xem mục
"Lưu ý quan trọng" bên dưới), nhưng **tab Reviews của shop** (`{shop_url}/reviews?ref=
pagination&page=N`, cũng phân trang) thì mỗi review có gắn link về đúng listing được
review — đây là nguồn duy nhất còn lấy được review-theo-sản-phẩm.

Bật ở tab Cài đặt (admin) → **"Lấy review từng sản phẩm khi rảnh"** (mặc định tắt, vì
đây là 1 cửa sổ Chrome thật chạy thêm ngoài lịch tự động). Khi bật, `scheduler.py`
kiểm tra mỗi 60 giây: nếu hàng đợi scrape chính hoàn toàn rảnh (không có shop nào
`pending`/`scraping`) **và** chưa có lượt lấy review nào khác đang chạy, hệ thống tự
chọn 1 shop đã scrape thành công (còn khả dụng, không đang vacation/closed) có
`reviews_scraped_at` cũ nhất/chưa từng lấy, mở 1 cửa sổ Chrome đi hết các trang Review
của shop đó (`scrape_shop_reviews_stealth` trong `scraper.py`), đếm số review theo
từng `etsy_listing_id`, rồi ghi vào `Listing.num_reviews` của các listing tương ứng.
Chạy trên thread riêng (không chặn vòng lặp scheduler chính) vì có thể mất vài phút
mỗi shop tuỳ số trang review.

**Chỉ đếm được review nào Etsy còn cho duyệt qua tab Reviews** — thường ít hơn nhiều
so với tổng số review "đã làm tròn" hiển thị ở đầu trang shop (Etsy giới hạn số trang
review xem được), nên đây là số gần đúng theo hướng thiếu, không phải tuyệt đối. Số
này dùng để **sắp xếp sản phẩm theo số review** ở grid listing (cả bên user lẫn admin)
và cải thiện độ chính xác của dự đoán "bán chạy nhất".

## Cách vượt DataDome tự động

Etsy bảo vệ trang shop bằng **DataDome** — chống bot fingerprint sâu (CDP, TLS, hành
vi). Playwright thuần (kể cả điều khiển Chrome thật) vẫn bị chặn 403 ngay ở response
đầu. Server dùng [Scrapling](https://github.com/D4Vinci/Scrapling)'s `StealthyFetcher`
(dựa trên Patchright — bản Playwright vá sâu các dấu vết CDP/automation) chạy
**Chrome thật, cửa sổ hiện hình** (`headless=False`) — cách này vượt được DataDome ở
mọi lần thử trong quá trình phát triển. Dán HTML thủ công vẫn được giữ làm phương án
dự phòng cuối cùng nếu Etsy đổi cách chặn khiến cách trên không còn ăn.

## Cấu trúc

- `server/` — FastAPI + SQLAlchemy + JWT auth + parser (BeautifulSoup) + Scrapling
  (StealthyFetcher/Patchright, scrape tự động chạy nền khi user thêm shop) + parse
  HTML dán tay làm phương án dự phòng
- `client/` — React + Vite

## Chạy server

Cần Python 3.11+ và một PostgreSQL đang chạy, database tên `etsy_scraper`.

```powershell
cd server
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m patchright install chromium   # tải Chromium riêng cho patchright (lần đầu)
copy .env.example .env   # sửa DATABASE_URL, JWT_SECRET, ADMIN_EMAIL/ADMIN_PASSWORD
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

**Lưu ý:** không dùng cờ `--reload` trên Windows — có bug khiến uvicorn báo
"Reloading..." nhưng tiến trình cũ vẫn chạy code cũ. Cứ Ctrl+C rồi chạy lại lệnh trên
sau mỗi lần sửa code server.

Lúc khởi động lần đầu (DB rỗng), server tự tạo bảng và tự tạo **1 tài khoản admin**
theo `ADMIN_EMAIL`/`ADMIN_PASSWORD` trong `.env` (mặc định `admin@example.com` /
`changeme123` — **nên đổi** trước khi dùng thật). Server chạy ở http://localhost:8000
(docs tại `/docs`).

**Nếu bạn đã có DB `etsy_scraper` từ trước** (tạo trước khi có `location`,
`total_sales`, `error_message`, và các status `scraping`/`failed`) — `create_all` chỉ
tạo bảng mới, không tự thêm cột/enum value vào bảng đã tồn tại. Chạy 1 lần:

```sql
ALTER TABLE shops ADD COLUMN IF NOT EXISTS location VARCHAR;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS total_sales INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TYPE shopstatus ADD VALUE IF NOT EXISTS 'scraping';
ALTER TYPE shopstatus ADD VALUE IF NOT EXISTS 'failed';
CREATE TABLE IF NOT EXISTS scraper_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  proxies JSON NOT NULL DEFAULT '[null]'
);
INSERT INTO scraper_settings (id, max_concurrent, proxies)
VALUES (1, 1, '[null]'::json) ON CONFLICT (id) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_value DOUBLE PRECISION;

ALTER TABLE shops ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS unavailable_reason VARCHAR;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS last_added_listings JSON NOT NULL DEFAULT '[]';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS last_removed_listings JSON NOT NULL DEFAULT '[]';

CREATE TYPE schedulemode AS ENUM ('off', 'fixed_time', 'auto');
CREATE TABLE IF NOT EXISTS schedule_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  mode schedulemode NOT NULL DEFAULT 'off',
  fixed_time VARCHAR
);
INSERT INTO schedule_settings (id, mode, fixed_time)
VALUES (1, 'off', NULL) ON CONFLICT (id) DO NOTHING;

ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_tenure VARCHAR;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS sales_delta INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS reviews_delta INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS sales_delta_week INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS reviews_delta_week INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS sales_delta_month INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS reviews_delta_month INTEGER;

CREATE TABLE IF NOT EXISTS shop_metric_snapshots (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  recorded_at TIMESTAMP NOT NULL DEFAULT now(),
  total_sales INTEGER,
  total_reviews INTEGER
);
CREATE INDEX IF NOT EXISTS ix_shop_metric_snapshots_shop_recorded
  ON shop_metric_snapshots (shop_id, recorded_at);

CREATE TABLE IF NOT EXISTS listing_change_log (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  etsy_listing_id VARCHAR,
  change_type VARCHAR NOT NULL,
  title TEXT,
  image_url TEXT,
  url TEXT,
  changed_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_listing_change_log_shop_changed
  ON listing_change_log (shop_id, changed_at);
CREATE INDEX IF NOT EXISTS ix_listing_change_log_changed_at ON listing_change_log (changed_at);

ALTER TABLE shops ADD COLUMN IF NOT EXISTS reviews_scraped_at TIMESTAMP;
ALTER TABLE schedule_settings ADD COLUMN IF NOT EXISTS scrape_reviews_when_idle BOOLEAN NOT NULL DEFAULT FALSE;

-- scrape_reviews_when_idle (on/off only) was replaced by review_mode/review_fixed_time,
-- same off/fixed_time/auto vocabulary as mode/fixed_time above.
ALTER TABLE schedule_settings ADD COLUMN IF NOT EXISTS review_mode schedulemode NOT NULL DEFAULT 'off';
ALTER TABLE schedule_settings ADD COLUMN IF NOT EXISTS review_fixed_time VARCHAR;
ALTER TABLE schedule_settings DROP COLUMN IF EXISTS scrape_reviews_when_idle;
```

## Chạy client

```powershell
cd client
npm install
copy .env.example .env
npm run dev
```

Mở http://localhost:5173.

- Bấm "Đăng ký" để tạo tài khoản user thường → thêm link shop + niche → shop hiện
  ngay "⏳ Đang chờ" rồi tự chuyển "🔄 Đang lấy thông tin..." (server đang mở Chrome
  thật ở nền, mất khoảng 10-30 giây mỗi trang). Dashboard tự poll, không cần bấm gì
  thêm.
- Xong sẽ thấy "✅ Đã cập nhật" kèm giờ cập nhật — click vào xem tên shop, địa điểm,
  rating, tổng sale, và lưới listing (ảnh + tên + giá) + dự đoán bán chạy nhất.
- Nếu ra "❌ Lỗi lấy dữ liệu" (Etsy chặn lần đó, hoặc đổi markup khiến parser không
  đọc được) — bấm "Thử lại" để chạy lại tự động, hoặc báo admin xử lý thủ công.
- Đăng nhập bằng tài khoản admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) để xem hàng đợi các
  shop đang chờ/lỗi trên toàn hệ thống. Chọn 1 shop, có 2 cách xử lý:
  - **Tự động:** bấm "Chạy tự động" — dùng lại cơ chế StealthyFetcher ở trên, tự đi
    hết nhiều trang (theo "Số trang tối đa").
  - **Thủ công (dự phòng cuối):** làm theo hướng dẫn F12 → Console →
    `copy(document.documentElement.outerHTML)` → dán vào ô → "Lưu trang 1". Nếu shop
    có nhiều trang, mở tiếp `?page=2`, `?page=3`... lấy HTML rồi dán vào lưu tiếp —
    mỗi lần lưu **cộng dồn** listing mới, không xoá dữ liệu trang trước.

## Lưu ý quan trọng

- **Số review của shop chỉ là gần đúng** — Etsy chỉ hiện dạng đã làm tròn trên trang
  shop (`"1k"`, `"234"`...), không có số chính xác như sales (sales có link `/sold`
  chứa số chính xác). `reviews_delta` vì vậy cũng chỉ tăng khi số review vượt sang
  mốc làm tròn tiếp theo, không phản ánh từng review lẻ.
- Etsy thường xuyên đổi markup trang. Nếu import ra rỗng hoặc thiếu field, kiểm tra
  các CSS selector ở đầu `server/app/scraper.py` (`LISTING_CARD_SELECTORS`,
  `TITLE_SELECTORS`, `PRICE_SELECTORS`) — mở trang shop thật, F12 xem cấu trúc HTML
  hiện tại rồi cập nhật.
- **Số review từng listing hiện không lấy được** — bản thiết kế card hiện tại của
  Etsy trên trang shop (`listing-card-experimental-style`) không còn hiển thị rating
  hay số review trên từng listing card nữa (đã kiểm tra trực tiếp trên nhiều shop,
  không phải lỗi selector). `num_reviews` sẽ luôn là `null` trừ khi Etsy đổi lại
  markup hoặc ta thêm bước ghé từng trang listing riêng (chậm hơn nhiều — 1 request/
  listing). Vì vậy dự đoán "bán chạy nhất" (`findBestseller` trong `ListingGrid.jsx`)
  hiện sẽ không hiện được cho tới khi có lại dữ liệu này.
- Rating **shop** (không phải từng listing) vẫn lấy được từ `div[data-rating]` ở
  header — ổn định hơn vì đây là số chính xác Etsy nhúng làm data attribute, không
  phải suy ra từ text hiển thị.
- Cơ chế tự động lấy dữ liệu (`scrape_shop_stealth` trong `scraper.py`) dùng
  [Scrapling](https://github.com/D4Vinci/Scrapling)'s `StealthyFetcher` với
  `real_chrome=True` (cần **Google Chrome thật** đã cài trên máy chạy server) và
  `headless=False` (mở cửa sổ Chrome thật, hiện hình — tắt `headless=False` xuống
  `True` sẽ bị Etsy chặn 403 lại, đã kiểm chứng). Trình duyệt patchright riêng cần
  cài lần đầu qua `python -m patchright install chromium` trong `.venv` nếu server
  báo thiếu executable.
- Mỗi lần user thêm shop, server mở **1 cửa sổ Chrome thật** chạy nền cho tới khi lấy
  xong hết các trang (mỗi trang ~6-8s) — bình thường với vài user, nhưng nếu nhiều
  user thêm shop cùng lúc sẽ mở nhiều cửa sổ Chrome song song, cần cân nhắc giới hạn
  concurrency nếu scale lên.
- Cân nhắc việc lấy dữ liệu từ Etsy có thể liên quan Điều khoản dịch vụ của họ tuỳ
  cách và quy mô sử dụng — dùng cho mục đích cá nhân/nghiên cứu.
