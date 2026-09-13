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

- `https://trends.pinterest.com`, cần Playwright
- Hai chế độ: trending theo quốc gia, và keyword research từ seed
- Trả về search volume, seasonality, momentum tuần/tháng/năm, và **52 tuần lịch sử**
- Rate limit thực tế: khoảng **57 request mỗi cửa sổ trượt, tính theo IP**. Token bucket
  phải tôn trọng con số này, đặt an toàn ở 45.
- **Backfill bắt buộc ở Phase 1:** 52 tuần lịch sử của Pinterest giải quyết trọn bài toán
  cold start. Không có nó thì phải chờ 3 tuần mới tính được velocity.
- Lý do đây là nguồn số một cho ba niche core: người dùng Pinterest lên kế hoạch cho việc
  chưa xảy ra — đám cưới, tiệc sinh nhật, sửa nhà — nên dữ liệu đi trước lúc mua hàng
  3-6 tháng. Đúng bằng lead time sản xuất của POD.
- **Thăm dò 2026-09-13 (Chrome DevTools automation, session đã đăng nhập):**
  - UI của trends.pinterest.com không render trong môi trường automation này (React
    Suspense streaming bị kẹt ở `<template id="B:0">`, không phải do tài khoản —
    chưa rõ nguyên nhân, có thể do thiếu tính năng trình duyệt cần cho chart).
    KHÔNG tương tác được với ô tìm keyword qua UI nên chưa xác nhận được chế độ
    "keyword research từ seed".
  - Dù UI không render, tầng dữ liệu vẫn gọi được: nhiều request tới
    `https://trends.pinterest.com/resource/ApiResource/get/` bọc các endpoint nội bộ
    `/ads/v4/trends/topics/featured/<country>/...`,
    `/ads/v4/trends/moment/available/<country>`,
    `/ads/v4/trends/shopping/product_categories`,
    `/ads/v4/trends/shopping/product_categories/top/<country>` (tham số
    `ranking_method=GROWTH`, `order_by=PCT_CHANGE_MOM` — đúng tín hiệu "đang tăng"),
    `/ads/v4/trends/shopping/product_categories/metrics/<country>` (tham số `days`,
    `predicted_days` — có vẻ là time-series, khớp mô tả "momentum tuần/tháng/năm").
    Tất cả trả `200` thật trên phiên đã đăng nhập.
  - **Chưa lấy được response body** của các endpoint trên: mọi lần thử trả nội dung ra
    ngoài phiên browser bị chặn bởi safety filter (nội dung có dạng cookie/query-string
    hoặc base64), và gọi lại thủ công cùng URL/tham số từ trong trang (không qua
    interceptor kịp trước khi navigate) trả `403` — cùng cơ chế CSRF như
    `pinterest_suggest`.
  - Đây là dữ liệu theo **product_category** (danh mục sản phẩm), chưa rõ có tương ứng
    1-1 với "keyword research từ seed" như mô tả trên hay là một chế độ khác — cần xác
    nhận thêm khi UI render được.
  - **Kết luận:** `pinterest_trends.py` cần Playwright thật (không chỉ để bắt request —
    để UI thật sự render và tương tác được, khác với pinterest_suggest chỉ cần
    cookie+CSRF cho một GET đơn giản). Việc dựng Playwright + xử lý màn hình trắng này
    là công việc riêng, chưa làm trong phiên này.

---

## Phase 2: nguồn bổ sung

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
