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
