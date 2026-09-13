# CLAUDE.md — POD Trend Scanner

Đọc file này trước khi viết bất kỳ dòng code nào. Sau đó đọc `TASKS.md` để biết
đang ở phase nào. Các file trong `docs/` là spec chi tiết, đọc khi cần.

## Hệ thống này làm gì

Mỗi ngày quét nhiều nguồn public để tìm keyword đang tăng trưởng trong mảng
print-on-demand, chấm điểm theo tốc độ tăng và độ bão hoà, lọc rủi ro sở hữu trí tuệ,
rồi sinh ra `design_brief` — một JSON đủ chi tiết để đưa vào model ảnh và ra được
sản phẩm hoàn chỉnh.

Chủ shop đang bán ba niche core: **wedding, birthday, custom photo**. Có thêm nhóm
mở rộng rủi ro cao hơn (funny tee, pop culture, political) chạy tách biệt.

```
collect → extract → metrics → enrich → risk → brief → dashboard duyệt → export
```

Sáu bước là sáu tiến trình độc lập. Giao tiếp qua Postgres, không gọi trực tiếp nhau.
Một bước chết thì bước sau không có việc mới, không sập dây chuyền.

## Stack — đã chốt, không tự đổi

| Thành phần | Lựa chọn | Lý do |
|---|---|---|
| Ngôn ngữ | Python 3.12 | Phần nặng là dữ liệu |
| Package manager | `uv` | Nhanh, lockfile ổn định |
| HTTP | `httpx` (async) + `tenacity` | Retry có backoff |
| DB | Postgres 16 | JSONB + window function |
| ORM | SQLAlchemy 2.0 + Alembic | Migration bắt buộc, không `create_all()` |
| Schema | Pydantic v2 | Validate mọi payload LLM |
| Scheduler | APScheduler | Đủ dùng, không cần Airflow |
| Browser | Playwright | CHỈ cho 2 adapter cần nó |
| Web | FastAPI + Jinja2 + HTMX | Không dựng SPA cho dashboard nội bộ |
| Log | `structlog` (JSON) | |
| Test | `pytest` + `pytest-asyncio` | |
| Deploy | Docker Compose | |

Nếu thấy cần thêm dependency, hỏi trước, đừng tự cài.

## Cấu trúc thư mục

```
src/scanner/
  adapters/          # mỗi nguồn một file, xem docs/SOURCES.md
    base.py          # SourceAdapter ABC
    google_suggest.py
    amazon_suggest.py
    bing_suggest.py
    pinterest_suggest.py
    pinterest_trends.py
  core/
    config.py        # pydantic-settings, đọc từ env
    db.py            # engine, session
    log.py           # cấu hình structlog JSON
    models.py        # SQLAlchemy models
    normalize.py     # chuẩn hoá + dedupe term
    ratelimit.py     # token bucket theo source
    seeds.py         # parse data/seed_keywords.json + sync bảng seeds
  pipeline/
    collect.py
    extract.py
    metrics.py
    enrich.py
    risk.py
    brief.py         # LLM sinh design_brief
    render.py        # brief -> image prompt (code thuần, KHÔNG dùng LLM)
  web/
    app.py
    templates/
  scheduler.py       # APScheduler: collect 02:00 UTC, metrics 03:00 UTC
  cli.py             # typer: scanner collect / metrics / risk / brief
tests/
migrations/
data/seed_keywords.json
docs/
```

## Quy tắc bắt buộc

**Dữ liệu**

1. `raw_items` là bất biến. Chỉ INSERT, không bao giờ UPDATE hay DELETE. Mọi metric
   là dẫn xuất và phải tính lại được từ raw. Công thức chấm điểm sẽ đổi hàng chục lần —
   nếu chỉ lưu kết quả cuối thì mỗi lần đổi là mất sạch lịch sử.
2. Mọi timestamp lưu UTC, cột `timestamptz`.
3. `unique(source_id, external_id)` trên `raw_items`. Chạy lại collector hai lần trong
   ngày không được sinh dữ liệu trùng.
4. Không lưu ảnh khách hàng ở bất kỳ đâu trong repo này. Hệ thống này chỉ xử lý keyword
   và brief, không xử lý dữ liệu cá nhân của người mua.

**Adapter**

5. Adapter thuần: `fetch()` trả raw, `extract(raw)` trả observations. Adapter KHÔNG được
   ghi DB, KHÔNG được gọi adapter khác. Pipeline mới là chỗ ghi.
6. Thêm nguồn mới = thêm 1 file trong `adapters/` + 1 dòng trong bảng `sources`.
   Không được sửa code core khi thêm nguồn. Nếu phải sửa core thì abstraction sai.
7. Mọi adapter đi qua `ratelimit.py`. Xem giới hạn cụ thể từng nguồn trong `docs/SOURCES.md`.
8. Adapter fail thì log và trả list rỗng, KHÔNG raise. Một nguồn chết không được làm
   hỏng cả lượt collect.

**LLM**

9. LLM chỉ làm ba việc: sinh `design_brief`, phân loại nguồn gốc cụm từ, viết listing copy.
   LLM KHÔNG phát hiện trend — số liệu làm việc đó.
10. Mọi output LLM validate bằng Pydantic trước khi ghi DB. Fail thì retry đúng 1 lần
    kèm thông báo lỗi, fail lần hai thì đánh dấu `status=llm_failed` và bỏ qua.
11. Không gọi LLM trong request path của dashboard. Dashboard chỉ đọc dữ liệu có sẵn.
12. Dùng Batch API cho job đêm.

**Risk**

13. Risk gate fail-closed: term chưa qua đủ các lớp kiểm tra thì KHÔNG vào hàng đợi duyệt.
    Mặc định là chặn, không phải cho qua. Chi tiết ở `docs/RISK_POLICY.md`.
14. Không tự động publish. Bước cuối luôn là người bấm duyệt.

**Không làm**

15. Không scrape Etsy. Điều khoản của Etsy cấm screen-scraping, và API chính thức không
    cho dữ liệu shop đối thủ. Dữ liệu Etsy vào hệ thống qua import CSV thủ công từ tool
    bên thứ ba. Viết importer, đừng viết scraper.
16. Không dùng Pinterest API v5. Nó có quy định cấm cache phần lớn dữ liệu API, xung đột
    trực tiếp với kiến trúc snapshot hằng ngày. Dùng trang Trends public thay thế.
17. Không hardcode secret. Tất cả qua env, có `.env.example`.
18. Không gọi network thật trong test. Dùng fixture trong `tests/fixtures/`.

## Chạy

```bash
uv sync
docker compose up -d postgres
uv run alembic upgrade head
uv run scanner seed --file data/seed_keywords.json
uv run scanner collect --source google_suggest
uv run scanner metrics
uv run uvicorn scanner.web.app:app --reload
```

## Định nghĩa "xong" cho mọi task

- Có test, và test chạy được offline
- Có type hint, `mypy` sạch
- Migration Alembic nếu đụng schema
- Log structlog ở các điểm quan trọng, không dùng `print`
- Nếu đổi hành vi thì cập nhật file docs tương ứng trong cùng commit
