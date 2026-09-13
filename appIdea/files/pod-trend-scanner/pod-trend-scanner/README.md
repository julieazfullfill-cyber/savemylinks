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

**3/4 acceptance đạt trên DB thật, 1 mục bị chặn (Pinterest, xem bên dưới).**

| Hạng mục | Trạng thái |
|---|---|
| `adapters/google_suggest.py`, `adapters/bing_suggest.py` | xong, fixture lấy từ endpoint thật |
| `adapters/pinterest_suggest.py`, `adapters/pinterest_trends.py` | **bị chặn** — xem "Pinterest bị chặn" bên dưới |
| `pipeline/metrics.py` (value_norm, velocity_7d/21d, accel, n_sources) | xong |
| `scheduler.py` (APScheduler: collect 02:00 UTC, metrics 03:00 UTC) | xong |
| `web/app.py` — trang HTML thô top term theo accel | xong |
| Test | 64 passed (offline + Postgres thật) |
| `mypy` strict | sạch, 22 file |

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
(ở cấp collect_source, không chỉ ở cấp từng seed — mức seed đã verify từ Phase 0).

### Pinterest bị chặn — pinterest_suggest và pinterest_trends chưa build được

`docs/SOURCES.md` yêu cầu bắt request thật qua devtools trước khi viết `extract()`,
không được đoán cấu trúc response. Đã thử hai cách trong phiên này:

1. **Chrome automation** (`mcp__claude-in-chrome`): extension chưa được cài/kết nối
   trên máy này — `tabs_context_mcp` trả lỗi "Browser extension is not connected".
2. **curl trực tiếp** (biết sẽ không đủ vì thiếu session cookie/CSRF của trình duyệt
   thật, thử để xác nhận): endpoint ứng viên `resource/BaseSearchResource/get/` trả
   `403` — đúng như dự đoán, Pinterest có anti-bot/CSRF chặn request không từ browser
   session thật.

Do đó **không viết `extract()` dựa trên cấu trúc JSON đoán mò** (đúng rule trong
SOURCES.md) — `pinterest_suggest.py` và `pinterest_trends.py` chưa tồn tại. Hệ quả:
- Acceptance "backfill Pinterest xong thì term_metrics_daily có dữ liệu lùi ≥ 26 tuần"
  chưa verify được — không có gì để backfill.
- `run_collect_all_sources` trong scheduler chỉ chạy 3 nguồn hiện có; thêm Pinterest
  vào `REGISTRY` là tự động được lịch chạy, không cần sửa `scheduler.py`.

**Cách gỡ, chọn một:**
- Cài Chrome extension claude-in-chrome trên máy này rồi làm lại bước bắt request qua
  devtools như SOURCES.md mô tả.
- Tự mở devtools trên pinterest.com, gõ vào ô search, copy request (URL + headers +
  cookie) và response mẫu, gửi lại — tôi viết fixture + adapter từ đó, không cần
  Chrome automation.
- Bỏ qua Pinterest ở Phase 1, quay lại sau khi có cách bắt request.
