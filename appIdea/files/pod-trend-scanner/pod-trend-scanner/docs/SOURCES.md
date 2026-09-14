# SOURCES.md — Adapter và giới hạn từng nguồn

Interface chung trong `adapters/base.py`:

```python
class SourceAdapter(ABC):
    name: str
    kind: str
    rate_limit: RateLimit

    @abstractmethod
    async def fetch(self, seed: str) -> list[RawItem]: ...

    @abstractmethod
    def extract(self, raw: RawItem) -> list[Observation]: ...
```

`fetch` chỉ lấy dữ liệu. `extract` chỉ parse. Không adapter nào được ghi DB.

**Trước khi code adapter mới:** viết một smoke test gọi endpoint thật một lần, lưu response
vào `tests/fixtures/<source>.json`, rồi mới viết `extract` dựa trên fixture đó. Đừng đoán
cấu trúc response.

---

## Phase 0-1: nguồn không cần API key

### amazon_suggest — làm đầu tiên

- Endpoint: `https://completion.amazon.com/api/2017/suggestions`
- Params chính: `mid` (marketplace id, US = `ATVPDKIKX0DER`), `alias=aps`, `prefix=<seed>`, `limit=11`
- Rate limit tự đặt: 1 req/giây, tối đa 200 req/lượt collect
- Header: cần User-Agent trình duyệt thật, không để mặc định của httpx
- Giá trị: ý định mua thật, sát POD nhất trong tất cả các nguồn free

### google_suggest

- Endpoint: `https://suggestqueries.google.com/complete/search`
- Params: `client=firefox`, `q=<seed>`, `hl=en`, `gl=us`
- Response là JSON array, phần tử [1] là danh sách gợi ý
- Rate limit: 1 req/giây. Vượt sẽ bị 429 tạm thời, không ban vĩnh viễn

### bing_suggest

- Endpoint: `https://api.bing.com/osjson.aspx?query=<seed>`
- Free, không key, format OpenSearch JSON
- Dùng để cross-check google_suggest, tăng `n_sources`

### pinterest_suggest

- Autocomplete của thanh tìm kiếm Pinterest
- **Đã bắt được request thật** qua Chrome DevTools automation trên phiên đã đăng nhập
  (2026-09-13). Endpoint và schema response — chi tiết đầy đủ ở docstring
  `adapters/pinterest_suggest.py`, tóm tắt:
  - `GET https://www.pinterest.com/resource/AdvancedTypeaheadResource/get/` với
    `source_url` + `data` (JSON: `options.pin_scope`, `options.count`,
    `options.term=<seed>`, `context={}`)
  - `resource_response.data.items[]`: field `type` ("query" = gợi ý thật, "user" =
    khớp tên người dùng, bỏ qua), `query` (text), `resultIndex` (rank, đánh số từ 0)
  - `pin_count` luôn quan sát thấy bằng 0 — không phải volume thật, khác Pinterest
    Trends. value_norm vẫn tính theo rank như adapter autocomplete khác.
- **Cần cookie phiên đăng nhập.** Gọi không kèm cookie trả `403 Invalid Resource
  Request` — đã xác nhận trực tiếp (gọi lại đúng URL/tham số nhưng thiếu CSRF token
  suy ra từ cookie). Set `PINTEREST_COOKIE` trong `.env`, xem `.env.example`. Cookie
  hết hạn định kỳ, cần refresh thủ công cho tới khi chuyển sang Playwright persistent
  context (xem mục "Không hardcode path đoán mò" cũ — nay đổi thành "không hardcode
  cookie": tuyệt đối không commit cookie thật vào repo).
- Đây là nguồn keyword free chính xác nhất cho mảng wedding/birthday/gift

### pinterest_trends — nguồn quan trọng nhất

- **Endpoint thật, public, KHÔNG cần đăng nhập, KHÔNG cần Playwright lúc chạy production**
  (Playwright chỉ dùng để dò ra endpoint — xem "Quá trình dò tìm" bên dưới):

  ```
  GET https://trends.pinterest.com/metrics/
      ?terms=<seed>            (nhiều seed: nối dấu phẩy, url-encode)
      &country=US
      &end_date=<YYYY-MM-DD>   (PHẢI là một Thứ Sáu — xem "end_date" bên dưới)
      &days=365
      &aggregation=2
      &normalize_against_group=false
      &predicted_days=0
  ```

  Response: JSON array, một phần tử mỗi term **có đủ dữ liệu** (term ít volume bị bỏ
  lặng lẽ khỏi response — không phải lỗi, đã xác nhận: gửi 20 seed thật chỉ 11 seed có
  mặt trong response). Mỗi phần tử: `term`, `growth_rates` (wow/mom/yoy % thay đổi),
  `counts[]` — chuỗi TUẦN `{date, count, normalizedCount,
  predictedUpperBoundNormalizedCount, predictedLowerBoundNormalizedCount}`.

- **Đã xác nhận thật: 53 tuần lịch sử** (2025-09-05 → 2026-09-04, `predicted_days=0`
  loại hết điểm dự đoán) — vượt yêu cầu 52 tuần. Chạy thật qua toàn bộ pipeline
  (`scanner collect --source pinterest_trends` → `scanner metrics --recompute`) ra đúng
  53 ngày trong `term_metrics_daily`, velocity/accel tính đúng trên dữ liệu thật.

- **`end_date` phải là Thứ Sáu đã "publish" xong** — Pinterest tổng hợp theo tuần
  (mốc Thứ Sáu) và có độ trễ publish không cố định. Xác nhận trực tiếp: gọi với
  `end_date` là hôm nay hoặc Thứ Sáu gần nhất (2 ngày trước) đều trả `400`, Thứ Sáu
  tuần trước đó (9 ngày trước) trả `200`. Adapter tự lùi dần từng tuần khi gặp `400`
  (tối đa 4 tuần), không hardcode số ngày trễ.

- Hai chế độ mô tả trong bản gốc tài liệu này ("trending theo quốc gia" và "keyword
  research từ seed") — endpoint `/metrics/` ở trên chính là chế độ thứ hai, và đã đủ
  cho toàn bộ nhu cầu của hệ thống (search volume + momentum theo từng seed cụ thể).
  Route `/search/` (UI đẹp hơn, có thể có thêm tính năng) yêu cầu đăng nhập — chưa cần
  khám phá thêm vì `/metrics/` đã đáp ứng đủ acceptance.

- Rate limit thực tế: khoảng **57 request mỗi cửa sổ trượt, tính theo IP** (áp dụng
  chung cho domain trends.pinterest.com, không riêng endpoint này). Token bucket đặt an
  toàn ở 45 req/60s, burst 5 — verify bằng đồng hồ ảo, xem `tests/test_ratelimit.py`.

- Lý do đây là nguồn số một cho ba niche core: người dùng Pinterest lên kế hoạch cho việc
  chưa xảy ra — đám cưới, tiệc sinh nhật, sửa nhà — nên dữ liệu đi trước lúc mua hàng
  3-6 tháng. Đúng bằng lead time sản xuất của POD.

#### Quá trình dò tìm (2026-09-13)

Ban đầu thử qua Chrome DevTools automation (`claude-in-chrome`) — UI trends.pinterest.com
không render trong môi trường đó (React Suspense kẹt), nên chuyển sang Playwright thật
(`playwright.chromium`, cài qua `uv sync --extra browser`). Phát hiện theo thứ tự:

1. Playwright thật render đúng, kể cả headless — vấn đề trước đó là do dùng
   `wait_until="networkidle"` (trang giữ kết nối nền liên tục, không bao giờ "idle"),
   đổi sang `wait_until="load"` + chờ cố định là đủ.
2. Trang tự gọi nhiều endpoint nội bộ dạng `resource/ApiResource/get/` bọc
   `/ads/v4/trends/...` (topics/featured, product_categories, …) — đây là dữ liệu theo
   category, có CSRF chặn nếu tự construct request, và chỉ có ~13 tuần lịch sử.
3. Trong lúc trang tải, còn thấy 2 request dạng **REST thuần, không qua wrapper**:
   `top_trends_filtered/` và `metrics/?terms=...`. Thử gọi `metrics/` trực tiếp bằng
   `curl` (không cookie, không browser) với seed tự chọn — **thành công**, và có
   `days=365`. Đây chính là endpoint đang dùng trong `adapters/pinterest_trends.py`.

Bài học: adapter cuối cùng KHÔNG cần Playwright — hoàn toàn httpx thuần như 3 adapter
autocomplete kia. Bảng stack trong `CLAUDE.md` ("Playwright CHỈ cho 2 adapter cần nó")
viết trước khi biết điều này; thực tế 0 adapter cần Playwright lúc chạy production,
chỉ cần lúc **dò tìm** endpoint mới. Vẫn giữ Playwright là optional dependency
(`extra browser`) phòng khi cần dò thêm nguồn khác sau này.

---

## Phase 2: nguồn bổ sung

### amazon_search_count — đếm listing cạnh tranh cho `pipeline/enrich.py`

- `GET https://www.amazon.com/s?k=<term>` — trang search HTML công khai, không key,
  không auth. Xác nhận thật (2026-09-14): không dính CAPTCHA/anti-bot với UA trình
  duyệt thật thông thường, khác hẳn Pinterest.
- Đọc số "results for" trong `<h2 class="...a-text-normal">`, 3 dạng response thật:
  - `"No results for your search query."` -> 0
  - `"27 results for"` -> đếm chính xác (số nhỏ)
  - `"1-48 of over 3,000 results for"` -> đếm gần đúng, Amazon tự làm tròn (số lớn)
- Parse bằng regex trên HTML thô (không dùng parser mới, tránh xin thêm dependency —
  pattern hẹp và ổn định qua nhiều lần thử thật). Xem `pipeline/enrich.py` và fixture
  `tests/fixtures/amazon_search_*.html`.
- Rate limit tự đặt: 1 req/giây, giống `amazon_suggest` (chưa có số liệu chính thức
  riêng cho trang search, tự đặt an toàn).
- Cache 7 ngày trong `term_enrichment.checked_at` — không check lại term vừa check
  gần đây, tiết kiệm ngân sách "top 100 term/ngày" (acceptance Phase 2).
- Chỉ dùng cho `competing_listings`/`saturation_score`. `commercial_signal` KHÔNG gọi
  nguồn này — suy ra từ observation `amazon_suggest` đã có sẵn trong DB.

### amazon_movers — HTML công khai

- Trang Movers & Shakers và New Releases theo category, cập nhật theo giờ
- Category quan tâm: Home & Kitchen, Clothing, Handmade
- Tín hiệu về **format sản phẩm** đang lên, không phải keyword
- Playwright hoặc httpx + selectolax đều được; thử httpx trước

### etsy_csv_import — KHÔNG PHẢI SCRAPER

Etsy cấm screen-scraping trong điều khoản, và API v3 chia ba tầng: Seller App duyệt
trong vài phút nhưng chỉ truy cập được shop của chính bạn; Personal App qua review sâu
hơn; Commercial Access phải có Personal App được duyệt trước rồi review thủ công riêng.
Không tầng nào cho dữ liệu shop đối thủ.

Nên: viết `scanner import-etsy --file export.csv` nhận CSV export từ tool bên thứ ba
(eRank, Everbee, Alura). Map cột vào `term_observations` với `source.kind='import'`.

### tiktok_creative_center

- Public, không cần login, Playwright
- Hashtag và keyword trending theo ngành và quốc gia
- Giá trị chính là tín hiệu **thẩm mỹ**: phong cách nào đang lên (y2k, coquette, groovy)
- Rate limit tự đặt: 1 req/2 giây, chạy 1 lần/ngày

---

## Không dùng

| Nguồn | Lý do |
|---|---|
| Pinterest API v5 | Cấm cache phần lớn dữ liệu API — xung đột trực tiếp với kiến trúc snapshot. Trial access nhiều báo cáo chờ 10+ ngày. Dùng trang Trends public. |
| Etsy Open API | Không tầng nào cho dữ liệu đối thủ. Dùng CSV import. |
| Reddit | Giá trị thấp với wedding/birthday/custom_photo. Chỉ cân nhắc sau Phase 5 nếu đẩy mạnh funny tee. |
| TikTok Research API | Chỉ cấp cho nghiên cứu học thuật. |
| Instagram Graph | Chỉ truy cập được tài khoản của chính mình. |
| X / Twitter API | Chi phí không tương xứng giá trị. |
| pytrends | Free nhưng 429 liên tục, không chịu nổi cron hằng ngày. Nếu cần Google Trends thì mua SerpApi hoặc DataForSEO ở Phase 2+. |

---

## Rate limiting

`core/ratelimit.py` — token bucket, một bucket cho mỗi source, cấu hình trong
`sources.config.rate_limit`:

```json
{"requests": 45, "per_seconds": 60, "burst": 5}
```

Mọi adapter phải `async with self.rate_limit:` trước mỗi request. Không có ngoại lệ.
Bị chặn IP là mất nguồn dữ liệu nhiều tuần, đắt hơn nhiều so với chạy chậm.
