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
- **Quan trọng:** endpoint nội bộ, không có tài liệu công khai. Mở devtools trên
  pinterest.com, gõ vào ô search, bắt request JSON, ghi đúng path vào `sources.config`.
  Không hardcode path đoán mò trong code — để trong config để sửa được khi Pinterest đổi.
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
