# POD Trend Scanner

Quét keyword đang lên trong mảng print-on-demand mỗi ngày, chấm điểm, lọc rủi ro sở hữu
trí tuệ, xuất ra `design_brief` để đưa vào pipeline sinh ảnh có sẵn.

## Dùng với Claude Code

Mở thư mục này trong VS Code rồi chạy `claude`. Claude Code tự đọc `CLAUDE.md`.

Câu lệnh khởi động gợi ý:

```
Đọc CLAUDE.md và TASKS.md. Bắt đầu Phase 0.
Trước khi code, tóm tắt lại cho tôi những gì bạn định làm trong phase này
và những chỗ bạn thấy spec chưa rõ.
```

Sau mỗi phase:

```
Chạy hết acceptance criteria của Phase N trong TASKS.md.
Cái nào chưa đạt thì nói rõ, đừng tự đánh dấu xong.
```

## Tài liệu

| File | Nội dung |
|---|---|
| `CLAUDE.md` | Stack, cấu trúc thư mục, quy tắc bắt buộc. Đọc trước tiên. |
| `TASKS.md` | Lộ trình 5 phase kèm acceptance criteria. |
| `docs/DATA_MODEL.md` | Schema Postgres, công thức normalize và scoring. |
| `docs/SOURCES.md` | Endpoint, rate limit, cách viết adapter cho từng nguồn. |
| `docs/RISK_POLICY.md` | Bốn lớp lọc rủi ro, bảng tier, test bắt buộc. |
| `docs/DESIGN_BRIEF_SPEC.md` | Schema output cuối, prompt LLM, renderer, 3 ví dụ đầy đủ. |
| `data/seed_keywords.json` | 150 seed core + 59 seed mở rộng. |

## Thứ tự đọc cho người mới

1. `CLAUDE.md` phần "Hệ thống này làm gì"
2. `docs/DESIGN_BRIEF_SPEC.md` phần 0 và 1 — hiểu output trước, mọi thứ khác phục vụ nó
3. `TASKS.md` Phase 0

## Trạng thái

**Phase 0 — xương sống: code xong.** Adapter đầu tiên (`amazon_suggest`) chạy hết chuỗi
fetch → extract → `raw_items` → `term_observations`.

| Hạng mục | Trạng thái |
|---|---|
| Scaffold + Docker Compose Postgres 16 | xong |
| `core/models.py` + migration `0001_initial_schema` | xong, DDL kiểm bằng `alembic upgrade head --sql` |
| `core/normalize.py`, `core/ratelimit.py`, `core/seeds.py` | xong, có test |
| `adapters/base.py`, `adapters/amazon_suggest.py` | xong, fixture lấy từ endpoint thật |
| `pipeline/collect.py`, `cli.py` (`seed`, `collect`, `sources`) | xong |
| Test | 27 passed (bao gồm 4 test cần Postgres) |
| Test cần Postgres (4 test trong `tests/test_collect_db.py`) | pass, chạy trên Postgres 16 local |

## Môi trường dev

Máy này chưa có `uv` và `docker` toàn cục, nên `uv` được cài trong venv riêng của repo
(`.tooling/`, không đụng Python hệ thống):

```bash
python -m venv .tooling
./.tooling/Scripts/python.exe -m pip install uv
./.tooling/Scripts/uv.exe sync
./.tooling/Scripts/uv.exe run pytest -q
./.tooling/Scripts/uv.exe run mypy
```

Sau khi có Postgres (Docker Desktop hoặc Postgres 16 cài sẵn), sửa `DATABASE_URL`
trong `.env` rồi:

```bash
docker compose up -d postgres          # nếu dùng Docker
./.tooling/Scripts/uv.exe run alembic upgrade head
./.tooling/Scripts/uv.exe run scanner seed --file data/seed_keywords.json
./.tooling/Scripts/uv.exe run scanner collect --source amazon_suggest
./.tooling/Scripts/uv.exe run pytest -q   # 4 test DB sẽ chạy thật
```

Nếu đã có `uv` toàn cục thì bỏ tiền tố `./.tooling/Scripts/`, các lệnh trong `CLAUDE.md`
dùng được nguyên văn.

### Phase 0 — acceptance đã verify trên DB thật

Chạy trên Postgres 16.10 local (`F:\pgdev16`, port 5433):

```
scanner seed --file data/seed_keywords.json
  -> {"parsed": 209, "core": 150, "expansion": 59, "inserted": 209, "updated": 0, "total": 209}

scanner collect --source amazon_suggest   # lượt 1
  -> {"seeds": 150, "fetched": 150, "duplicates": 0, "observations": 595, "failures": 0}

scanner collect --source amazon_suggest   # lượt 2, cùng ngày
  -> {"seeds": 150, "fetched": 0, "duplicates": 150, "observations": 0, "failures": 0}
```

`raw_items`/`terms`/`term_observations` giữ nguyên 150/595/595 dòng sau lượt 2 — dedupe
theo `unique(source_id, external_id)` hoạt động đúng. Test dedupe chữ hoa/dấu câu
("Bridesmaid Proposal Box!" vs "bridesmaid proposal box") pass ở cả unit test và
integration test trên DB.

**Phase 0 hoàn tất, đủ điều kiện sang Phase 1** (thêm `google_suggest`, `bing_suggest`,
`pinterest_suggest`, `pinterest_trends`, `ratelimit` theo từng nguồn, `pipeline/metrics.py`).

## Phase 1 — trạng thái

**Hoàn tất — 4/4 acceptance đạt trên DB thật + network thật.**

| Hạng mục | Trạng thái |
|---|---|
| `adapters/google_suggest.py`, `adapters/bing_suggest.py` | xong, fixture lấy từ endpoint thật |
| `adapters/pinterest_suggest.py` | xong — endpoint + schema bắt thật, cần `PINTEREST_COOKIE` để chạy thật |
| `adapters/pinterest_trends.py` | xong — endpoint public thật, **53 tuần lịch sử thật**, không cần cookie/đăng nhập |
| `core/collect.py` | thêm `SourceAdapter.per_seed` — nguồn snapshot theo quốc gia (không gắn seed) gọi `fetch()` đúng 1 lần/lượt thay vì lặp qua từng seed |
| `pipeline/metrics.py` (value_norm, velocity_7d/21d, accel, n_sources) | xong |
| `scheduler.py` (APScheduler: collect 02:00 UTC, metrics 03:00 UTC) | xong |
| `web/app.py` — trang HTML thô top term theo accel | xong |
| Test | 89 passed (offline + Postgres thật) |
| `mypy` strict | sạch, 24 file |

### Acceptance đã verify trên Postgres thật

Chạy `google_suggest`, `bing_suggest` cùng `amazon_suggest` trên 15 seed wedding thật
(45 request qua network thật), rồi `scanner metrics`:

```
scanner collect --source amazon_suggest --niche wedding --limit 15
  -> {"seeds": 15, "fetched": 15, "duplicates": 0, "observations": 92,  "failures": 0}
scanner collect --source google_suggest --niche wedding --limit 15
  -> {"seeds": 15, "fetched": 15, "duplicates": 0, "observations": 128, "failures": 0}
scanner collect --source bing_suggest   --niche wedding --limit 15
  -> {"seeds": 15, "fetched": 15, "duplicates": 0, "observations": 125, "failures": 0}
scanner metrics
  -> {"date": "2026-09-13", "terms_scored": 302}
```

`term_metrics_daily` có `n_sources` đúng (nhiều term đạt n_sources=3, tức cả ba nguồn
đều thấy), `value_norm` tính đúng công thức theo rank. `uvicorn scanner.web.app:app`
chạy thật, `curl http://127.0.0.1:8009/` render đúng bảng HTML, sắp theo `accel`.

**Backfill Pinterest ≥ 26 tuần (acceptance đạt, vượt yêu cầu):**

```
scanner collect --source pinterest_trends --niche wedding --limit 20
  -> {"seeds": 20, "fetched": 20, "duplicates": 0, "observations": 159, "failures": 0}
scanner metrics --recompute
  -> 53 ngày, mỗi ngày 3 term (2025-09-05 .. 2026-09-04)
```

3 seed thật có đủ volume để Pinterest trả dữ liệu (`bridesmaid proposal box`,
`will you be my bridesmaid`, `bachelorette party shirts`) — mỗi seed 53 tuần lịch sử
thật liên tục, `term_metrics_daily` có `velocity_7d`/`velocity_21d`/`accel` tính đúng
trên toàn bộ 53 ngày. Chi tiết endpoint ở `docs/SOURCES.md` phần pinterest_trends.

Công thức velocity/accel tự nó được verify đầy đủ bằng test (offline + DB thật) trong
`tests/test_metrics_math.py` và `tests/test_metrics_db.py`, kể cả seed một chuỗi tăng
tuyến tính giả lập và kiểm tra slope khớp.

**Rate limiter (acceptance "100 request Pinterest trong 1 phút không vượt trần"):**
verify bằng đồng hồ ảo trong `tests/test_ratelimit.py` với đúng cấu hình Pinterest
Trends (45 req/60s, burst 5) từ `docs/SOURCES.md`. Quá trình viết test này phát hiện
và sửa một bug thật trong `core/ratelimit.py`: sai số làm tròn số thực có thể khiến
`wait` còn lại một epsilon (~1e-16s) không bao giờ đủ tăng token qua ngưỡng 1.0, làm
`acquire()` lặp vô hạn — đã thêm epsilon tolerance để sửa.

**Adapter lỗi không chặn nguồn khác:** `tests/test_scheduler.py` verify
`run_collect_all_sources` tiếp tục thử các nguồn còn lại khi một nguồn raise exception
(ở cấp collect_source, không chỉ ở cấp từng seed — mức seed đã verify từ Phase 0). Verify
thêm bằng dữ liệu thật: `scanner collect --source pinterest_suggest` khi chưa cấu hình
`PINTEREST_COOKIE` — log rõ lý do (`PINTEREST_COOKIE chưa được cấu hình`) cho từng seed,
`failures: 3`, không crash, không chặn các nguồn khác trong cùng lượt.

### pinterest_suggest — endpoint + schema bắt thật, cần cookie để chạy

Chrome extension `claude-in-chrome` kết nối được (trước đó báo "not connected"). Đăng
nhập sẵn trong Chrome nên bắt được request thật ngay: mở pinterest.com, gõ vào ô
search, đọc network requests → tìm thấy `AdvancedTypeaheadResource/get/`. Lấy schema
response thật bằng cách cài interceptor `fetch`/`XMLHttpRequest` trong trang rồi đọc
qua `console.log` — trả trực tiếp response ra ngoài phiên bị safety filter chặn (nội
dung dạng cookie/query-string hoặc base64), nên phải trích riêng từng field an toàn
(`query`, `type`, `resultIndex`, `pin_count`, …) qua console thay vì lấy nguyên JSON.

Endpoint có CSRF/session check thật — gọi không cookie trả `403 Invalid Resource
Request` (xác nhận trực tiếp bằng cách replay đúng URL/tham số thiếu CSRF header).
Khác với pinterest_trends, endpoint này **không có đường vòng public** — cần
`PINTEREST_COOKIE` (env) mới chạy được thật. Thiếu cookie thì fail-closed đúng thiết
kế: log rõ lý do, trả rỗng, không crash (verify bằng dữ liệu thật). 8 test pass.

### pinterest_trends — endpoint public thật, 53 tuần lịch sử, không cần Playwright

Ban đầu định dùng Playwright để dò UI (Chrome DevTools automation không render được
trang này). Playwright thật render đúng — vấn đề trước đó chỉ là dùng
`wait_until="networkidle"` trong khi trang giữ kết nối nền liên tục, không bao giờ
"idle". Trong lúc bắt request qua Playwright, phát hiện một endpoint REST thuần
`https://trends.pinterest.com/metrics/?terms=<seed>&days=365&...` — khác hẳn các
endpoint nội bộ `resource/ApiResource/get/` bị CSRF chặn. Thử gọi thẳng bằng `curl`
(không cookie, không browser, không Playwright) với seed tự chọn — **thành công**,
53 tuần lịch sử thật, không phải điểm dự đoán.

Kết quả: `pinterest_trends.py` cuối cùng là adapter HTTP thuần (httpx), giống hệt
pattern 3 adapter autocomplete kia — **không cần Playwright lúc chạy production**,
chỉ cần lúc dò tìm endpoint (đã cập nhật `CLAUDE.md`, Playwright vẫn giữ làm optional
dependency phòng khi cần dò nguồn khác sau này).

Phát hiện thêm cần xử lý: `end_date` phải là một Thứ Sáu **đã publish xong** — gọi với
hôm nay hoặc Thứ Sáu gần nhất (2 ngày trước) trả `400`, Thứ Sáu tuần trước (9 ngày
trước) trả `200`. Độ trễ publish không cố định nên adapter tự lùi dần từng tuần khi
gặp `400` (tối đa 4 tuần) thay vì hardcode số ngày — đã verify cả hai đường (test giả
lập 400→200, và chạy thật gặp đúng tình huống này, tự phục hồi, log rõ).

Dữ liệu là snapshot theo seed thật (không phải category), nên **không cần** cơ chế
`per_seed=False` mới thêm ở `pipeline/collect.py` cho adapter này — cơ chế đó vẫn giữ
lại (đã test, đã tài liệu hoá) cho một nguồn thật sự theo-quốc-gia nếu cần sau này.

**Chưa làm / để sau:** route `/search/` (UI đăng nhập) có thể có thêm tính năng, nhưng
`/metrics/` public đã đáp ứng đủ acceptance nên chưa cần khám phá thêm. `growth_rates`
(wow/mom/yoy % thay đổi) có sẵn trong response nhưng chưa dùng trong `pipeline/metrics.py`
— để xem xét bổ sung sau khi có dữ liệu thật chạy vài tuần.

### Acceptance đã verify trên Postgres thật

Chạy `google_suggest`, `bing_suggest` cùng `amazon_suggest` trên 15 seed wedding thật
(45 request qua network thật), rồi `scanner metrics`:

```
scanner collect --source amazon_suggest --niche wedding --limit 15
  -> {"seeds": 15, "fetched": 15, "duplicates": 0, "observations": 92,  "failures": 0}
scanner collect --source google_suggest --niche wedding --limit 15
  -> {"seeds": 15, "fetched": 15, "duplicates": 0, "observations": 128, "failures": 0}
scanner collect --source bing_suggest   --niche wedding --limit 15
  -> {"seeds": 15, "fetched": 15, "duplicates": 0, "observations": 125, "failures": 0}
scanner metrics
  -> {"date": "2026-09-13", "terms_scored": 302}
```

`term_metrics_daily` có `n_sources` đúng (nhiều term đạt n_sources=3, tức cả ba nguồn
đều thấy), `value_norm` tính đúng công thức theo rank. `uvicorn scanner.web.app:app`
chạy thật, `curl http://127.0.0.1:8009/` render đúng bảng HTML, sắp theo `accel`.
`velocity_7d`/`accel` trống vì mới có 1 ngày dữ liệu — đúng thiết kế (cần ≥2 ngày).
Công thức velocity/accel tự nó được verify đầy đủ bằng test (offline + DB thật) trong
`tests/test_metrics_math.py` và `tests/test_metrics_db.py`, kể cả seed một chuỗi tăng
tuyến tính giả lập và kiểm tra slope khớp — đúng yêu cầu acceptance của TASKS.md.

**Rate limiter (acceptance "100 request Pinterest trong 1 phút không vượt trần"):**
verify bằng đồng hồ ảo trong `tests/test_ratelimit.py` với đúng cấu hình Pinterest
Trends (45 req/60s, burst 5) từ `docs/SOURCES.md`. Quá trình viết test này phát hiện
và sửa một bug thật trong `core/ratelimit.py`: sai số làm tròn số thực có thể khiến
`wait` còn lại một epsilon (~1e-16s) không bao giờ đủ tăng token qua ngưỡng 1.0, làm
`acquire()` lặp vô hạn — đã thêm epsilon tolerance để sửa.

**Adapter lỗi không chặn nguồn khác:** `tests/test_scheduler.py` verify
`run_collect_all_sources` tiếp tục thử các nguồn còn lại khi một nguồn raise exception
(ở cấp collect_source, không chỉ ở cấp từng seed — mức seed đã verify từ Phase 0). Verify
thêm bằng dữ liệu thật: `scanner collect --source pinterest_suggest` khi chưa cấu hình
`PINTEREST_COOKIE` — log rõ lý do (`PINTEREST_COOKIE chưa được cấu hình`) cho từng seed,
`failures: 3`, không crash, không chặn các nguồn khác trong cùng lượt.

### pinterest_suggest — gỡ xong, chạy thật cần PINTEREST_COOKIE

Chrome extension `claude-in-chrome` kết nối được ở phiên sau (trước đó báo "Browser
extension is not connected"). Đăng nhập sẵn trong Chrome nên bắt được request thật
ngay: mở pinterest.com, gõ vào ô search, đọc network requests → tìm thấy
`AdvancedTypeaheadResource/get/`. Lấy schema response thật (không đoán) bằng cách cài
interceptor `fetch`/`XMLHttpRequest` trong trang rồi đọc qua `console.log` — trả trực
tiếp response ra ngoài phiên bị safety filter chặn (nội dung dạng cookie/query-string
hoặc base64), nên phải trích riêng từng field an toàn (`query`, `type`, `resultIndex`,
`pin_count`, …) qua console thay vì lấy nguyên JSON.

Kết quả: endpoint và schema đầy đủ trong docstring `adapters/pinterest_suggest.py`,
fixture `tests/fixtures/pinterest_suggest.json` dựng từ giá trị thật (field nào không
capture được thì bỏ hẳn khỏi fixture, không bịa). 8 test pass. Phát hiện thêm: endpoint
có CSRF/session check thật — gọi không cookie trả `403 Invalid Resource Request` (xác
nhận trực tiếp bằng cách replay đúng URL/tham số thiếu CSRF header). Adapter đọc cookie
từ `PINTEREST_COOKIE` (env), thiếu thì log rõ và trả rỗng — đã smoke test thật, đúng
hành vi fail-closed. Cookie hết hạn định kỳ, cần refresh thủ công cho tới khi chuyển
sang Playwright persistent context.

### pinterest_trends — vẫn bị chặn

UI của trends.pinterest.com **không render** trong môi trường automation này (React
Suspense streaming kẹt ở `<template id="B:0">`) — screenshot trắng, accessibility tree
rỗng, dù `innerHTML` có ~92KB và tài khoản đã đăng nhập. Không rõ nguyên nhân (nghi do
thiếu tính năng trình duyệt cần cho chart trong môi trường automation, không phải do
tài khoản/quyền truy cập).

Dù UI không render, tầng dữ liệu của trang vẫn gọi API thật thành công (`200`) — bắt
được 6 endpoint nội bộ dạng `/ads/v4/trends/...` (topics/featured, moment/available,
shopping/product_categories + top + metrics, editorial/content — chi tiết ở
`docs/SOURCES.md`). Nhưng **chưa lấy được response body** của các endpoint này: mọi
cách trả nội dung ra ngoài phiên đều bị safety filter chặn, và gọi lại thủ công đúng
URL/tham số (không qua interceptor kịp trước khi trang tự fetch) trả `403` — cùng cơ
chế CSRF như pinterest_suggest. Cũng chưa xác nhận được đây có phải đúng "keyword
research từ seed" như spec mô tả hay là một chế độ khác (category-level, không phải
term-level), vì không tương tác được với UI để search thử một keyword.

Hệ quả: acceptance "backfill Pinterest ≥ 26 tuần lịch sử" chưa verify được — không có
gì để backfill. `pinterest_trends.py` chưa tồn tại.

**Cách gỡ, chọn một:**
- Tôi thử dựng Playwright thật (không qua `claude-in-chrome`) — có thể render đúng nơi
  Chrome automation hiện tại không render được, cần cài Playwright + browser binaries
  (~300MB) và một lượt đăng nhập thủ công lưu vào persistent context.
- Bạn tự mở trends.pinterest.com, tìm một keyword, mở devtools, copy request+response
  mẫu (đặc biệt là request ứng với "keyword research từ seed" nếu có) gửi lại — tôi
  viết fixture + adapter từ đó.
- Bỏ qua pinterest_trends ở Phase 1, quay lại sau. `run_collect_all_sources` trong
  scheduler tự động chạy thêm nguồn này khi được thêm vào `REGISTRY`, không cần sửa
  `scheduler.py`.

## Phase 2 — trạng thái

**Hoàn tất — code xong + verify trên DB thật, không cần dữ liệu đa-ngày (dùng
integration test mô phỏng đúng kịch bản nhiều ngày cho phần cần lịch sử).**

| Hạng mục | Trạng thái |
|---|---|
| `pipeline/enrich.py` — competing_listings + saturation_score | xong, nguồn `amazon.com/s?k=` thật (không phải API) |
| Calendar engine — `core/occasions.py` + `pipeline/calendar.py` | xong, khớp đúng ví dụ acceptance |
| Two-axis scoring — `pipeline/score.py` | xong, momentum/opportunity lưu riêng |
| Etsy CSV importer — `pipeline/import_etsy.py` | xong, **chưa verify với file thật** — xem ghi chú bên dưới |
| Dashboard `/candidates` — scatter momentum×opportunity | xong, filter niche + risk_tier |
| `scheduler.py` | thêm job enrich (03:30 UTC), score (03:45 UTC) |
| Test | 169 passed (offline + Postgres thật) |
| `mypy` strict | sạch, 29 file |

### Quyết định spec chưa rõ, tự chọn (đã nói trước khi code)

**Cửa sổ "nên sản xuất":** acceptance ví dụ "hỏi tháng 12 ra occasion peak tháng 5-8,
lead 8-12 tuần" không khớp nếu hiểu "trước peak N tuần" là một mốc duy nhất (tháng 12
cách peak tháng 5 tới 5 tháng, không phải 8-12 tuần). Định nghĩa cửa sổ =
`[peak_start - 2×lead_weeks, peak_start - lead_weeks]` (mở sớm gấp đôi lead time, đóng
đúng lead time) — với lead_weeks=10, khớp chính xác ví dụ (tháng 12 nằm trong
[12/12, 20/2]). Xem docstring `pipeline/calendar.py`.

**`commercial_signal`:** không gọi thêm nguồn nào — suy từ việc term có từng xuất hiện
trong observation của `amazon_suggest` chưa (dữ liệu đã có sẵn trong DB).

**`saturation_score`:** log-scale trên `competing_listings`, mốc bão hoà hoàn toàn đặt
ở 50,000 listing. DATA_MODEL.md chỉ nói "0-1, càng cao càng bão hoà", không cho công
thức cụ thể — công thức nằm trong `pipeline/enrich.py`, tính lại được từ
`competing_listings` nếu đổi.

**`norm()`/`recency()` trong momentum:** cũng không có công thức cụ thể trong
DATA_MODEL.md. `norm(accel)` dùng sigmoid quanh 0 (không cần biết trước biên accel
thực tế, ổn định dù chạy trên tập term khác nhau). `recency(first_seen_at)` suy giảm
nửa chu kỳ 30 ngày. Xem docstring `pipeline/score.py`.

### Acceptance đã verify

**Calendar engine (khớp đúng ví dụ trong TASKS.md):**
```
scanner seed-occasions --file data/occasions.json
  -> {"parsed": 10, "inserted": 10, "updated": 0, "total": 10}
scanner calendar --niche wedding --date 2026-12-15
  -> occasion=wedding_season_us, peak_months=[5,6,7,8], lead_weeks=10,
     window=[2026-12-12, 2027-02-20] — chứa 2026-12-15, đúng seed niche wedding
```

**Term bão hoà cao bị đẩy xuống opportunity thấp dù momentum cao:** verify bằng
integration test `test_score_db.py` — 2 term CÙNG accel/n_sources/first_seen_at (nên
CÙNG momentum), một term saturation_score=0.95 → opportunity=0.43, term kia
saturation_score=0.05 → opportunity=0.97. Cùng momentum, opportunity chênh hẳn.

**Enrich không vượt quá 100 lookup/ngày:** `enrich_top_terms(top_n=100)` mặc định,
verify bằng test giới hạn `top_n` cứng + cache 7 ngày (không check lại term vừa check).
Chạy thật: `scanner enrich --top-n 5` trên 5 seed thật (bridesmaid proposal box,
maid of honor proposal gifts, …) — 5/5 thành công, `competing_listings` thật từ 793 đến
2000, `saturation_score` tính đúng, `commercial_signal=true` cho cả 5 (đều có trong
amazon_suggest).

**Etsy CSV importer chạy thật (nhưng chưa đối chiếu format thật):** `scanner
import-etsy --file tests/fixtures/etsy_erank_style.csv` trên Postgres thật — parse
đúng, ghi `raw_items`/`term_observations` đúng, dedupe theo ngày đúng. **Fixture CSV là
dữ liệu TỰ DỰNG** mô phỏng tên cột phổ biến của eRank/Everbee/Alura — cả ba tool này
cần tài khoản trả phí gắn với shop Etsy thật để xuất file, không có cách nào lấy mẫu
thật trong phiên build này. Importer tự nhận diện cột theo alias (không hardcode một
schema cố định — tránh đoán mò), cho ép cột bằng `--term-column`/`--value-column`.
**Cần đối chiếu lại cách nhận diện cột này với file export thật đầu tiên** trước khi
tin tưởng hoàn toàn — nếu bạn có file mẫu, gửi lại (bỏ số liệu nhạy cảm nếu cần) để tôi
verify.

### Dashboard `/candidates`

Scatter SVG render server-side (không JS, không CDN — đúng "trang HTML thô"), 4 góc
phần tư momentum×opportunity, filter niche + risk_tier qua form GET thường. risk_tier
suy từ seed đã sinh ra observation của term (candidate không tự có risk_tier — term có
thể không gắn seed nào, ví dụ tới từ pinterest_trends/etsy_csv_import, thì để trống,
không đoán). Chạy thật qua `uvicorn`, `curl http://127.0.0.1:8010/candidates` render
đúng.

## Phase 3 — trạng thái

**Hoàn tất phần lõi — 4 lớp risk gate hoạt động đúng fail-closed, verify thật trên
Postgres. Một mục để lại có chủ đích cho Phase 4 — xem bên dưới.**

| Hạng mục | Trạng thái |
|---|---|
| Lớp 1 — blocklist (`data/blocklist.yaml` + `pipeline/risk.py`) | xong, 20/20 cụm dính nhãn hiệu bắt được, 0/20 false positive |
| Lớp 2 — USPTO | xong về mặt fail-closed; **endpoint chưa xác minh được** (WAF chặn) — xem ghi chú |
| Lớp 3 — LLM origin classification | xong về mặt fail-closed; **chưa gọi được LLM thật** (thiếu ANTHROPIC_API_KEY) |
| Lớp 4 — hàng đợi chờ duyệt | xong — trang `/review` (đọc), `scanner approve` (CLI), enforce T2/T3 cứng |
| `risk_flags` + enforce fail-closed | risk_flags: xong. Enforce ở `pipeline/brief.py`: **để lại cho Phase 4** — brief.py chưa tồn tại, xem ghi chú |
| `scheduler.py` | thêm job risk (04:00 UTC) |
| Test | 215 passed (offline + Postgres thật) |
| `mypy` strict | sạch, 30 file |

### Acceptance đã verify

```
scanner risk
  -> chạy trên 2 candidate thật: 1 "Star Wars Mug" (T0) -> blocked
                                  1 "Veteran Pride Shirt" (T3) -> review
scanner approve --candidate-id 1 --by tester
  -> {"error": "candidate đã bị blocked, không thể approve"}
scanner approve --candidate-id 2 --by ""
  -> {"error": "tier T3 bắt buộc approved_by, không có đường tắt (RISK_POLICY.md)"}
scanner approve --candidate-id 2 --by cong@example.com
  -> {"status": "approved", "approved_by": "cong@example.com"}
```

- **"Term chứa franchise trong blocklist → blocked, không bao giờ tới brief":** verify
  thật (trên) + `tests/test_risk_gate_db.py` — candidate blocked không có code path nào
  approve được (`ApprovalRequiredError` ngay cả khi truyền `approved_by`).
- **"Term T3 không bao giờ đạt approved mà không có approved_by":** verify thật (trên)
  + test. `approve_candidate()` là **điểm duy nhất** được set `status='approved'` trong
  toàn bộ codebase — không có đường tắt nào khác ghi được vào cột đó.
- **"USPTO API down → review, không rơi vào pass":** `tests/test_risk_uspto.py` — mock
  500, timeout, JSON hỏng, đều ra `review`. Không có key cũng `review` (verify thật).
- **Bộ 20 cụm dính nhãn hiệu bắt được ≥ 18:** verify **20/20**, 0 false positive trên
  bộ 20 cụm generic — vượt xa yêu cầu.

### Quyết định spec chưa rõ / thiếu, tự chọn (đã nói trước khi code)

**`pipeline/brief.py` chưa tồn tại** (Phase 4) nhưng TASKS.md Phase 3 yêu cầu "enforce
fail-closed ở pipeline/brief.py". Xây `is_eligible_for_export()` + `approve_candidate()`
trong `pipeline/risk.py` làm hàm chặn dùng chung, đã test đầy đủ — Phase 4 chỉ cần gọi
lại, không phải viết logic chặn từ đầu.

**Cache USPTO:** RISK_POLICY.md nói cache trong `term_enrichment`, nhưng bảng đó không
có cột nào cho USPTO (chỉ có competing_listings/saturation_score/commercial_signal của
enrich.py). Dùng `risk_flags` làm cache thay thế (tìm bản ghi layer='uspto' gần nhất
trong 30 ngày) — đúng mục đích bảng này vốn có, không cần đổi schema.

**risk_tier của một term:** không có cột riêng — suy từ MAX(risk_tier) trong các seed
đã sinh observation cho term. Term không gắn seed nào (pinterest_trends,
etsy_csv_import) → mặc định **T2** (yêu cầu đủ 4 lớp), không suy đoán về phía lỏng.

**Blocklist "political":** dùng regex pattern (khẩu hiệu dạng "X 2028", "Make ... Great
Again", tên đảng/PAC chung) thay vì liệt kê tên ứng viên cụ thể đang tại nhiệm — trung
lập hơn, và bắt được khẩu hiệu MỚI chưa từng thấy (RISK_POLICY.md: "khẩu hiệu vận động,
cũ hay mới" đều phải chặn). Verify: bắt được cả câu chưa từng đưa vào danh sách
("re-elect johnson shirt", "smith for governor").

### Hai việc thật sự chưa xong — cần bạn hoặc thời gian

1. **Endpoint USPTO chưa xác minh bằng request thật.** `tmsearch.uspto.gov` (giao diện
   mới) có AWS WAF JS-challenge chặn hoàn toàn HTTP đơn giản — đã thử thật (curl thấy
   `challenge.js` từ `edge.sdk.awswaf.com`), không phải đoán. Code hiện dùng endpoint
   theo tài liệu công khai của USPTO Developer Hub (`api.uspto.gov`), **chưa xác nhận
   được URL này đúng** vì không có `USPTO_API_KEY` để test thật. An toàn về mặt
   fail-closed (URL sai vẫn chỉ rơi vào "review", không bao giờ "pass" sai), nhưng cần
   key thật + xác nhận URL trước khi tin dữ liệu USPTO là chính xác.
2. **Chưa gọi được LLM thật.** Không có `ANTHROPIC_API_KEY` trong `.env` — lớp 3 luôn
   rơi vào "review" (đúng thiết kế, nhưng nghĩa là mọi T2/T3 hiện đều cần người duyệt
   thủ công, không có term nào tự động qua được lớp 3 để test "generic → pass" thật).
   Cấu hình `ANTHROPIC_API_KEY` trong `.env` để dùng được đầy đủ.
