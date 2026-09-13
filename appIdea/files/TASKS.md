# TASKS.md — Lộ trình build

Làm tuần tự. Không nhảy phase. Mỗi phase phải qua hết acceptance criteria mới sang phase sau.

Nguyên tắc xuyên suốt: **lát cắt dọc trước, tầng ngang sau.** Một nguồn chạy hết chuỗi
từ fetch tới brief có giá trị hơn năm nguồn dừng ở bảng raw.

---

## Phase 0 — Xương sống (2-3 ngày)

Mục tiêu: một nguồn duy nhất chạy được end-to-end. Chưa cần đẹp, chưa cần scoring.

- [x] Scaffold repo theo cấu trúc trong CLAUDE.md, `uv init`, Docker Compose với Postgres
- [x] `core/models.py` đầy đủ theo `docs/DATA_MODEL.md`, migration Alembic đầu tiên
- [x] `core/normalize.py` — chuẩn hoá text, sinh `text_norm` và `text_key`
- [x] `adapters/base.py` — ABC `SourceAdapter` với `fetch()` / `extract()`
- [x] `adapters/amazon_suggest.py` — nguồn đầu tiên, HTTP thuần, không cần key
- [x] `pipeline/collect.py` — chạy adapter, ghi `raw_items` + `term_observations`
- [x] `cli.py` — lệnh `seed`, `collect`
- [x] Import `data/seed_keywords.json` vào bảng `seeds`

**Acceptance**
- `scanner seed` nạp đủ 209 seed, đúng `risk_tier` và `niche`
- `scanner collect --source amazon_suggest` chạy hết 150 seed core không lỗi
- Chạy lại lần hai trong cùng ngày: `raw_items` không tăng số dòng trùng
- Test dedupe: "Bridesmaid Proposal Box!" và "bridesmaid proposal box" ra cùng một `term_id`

---

## Phase 1 — Đủ nguồn + lịch sử (1 tuần)

Mục tiêu: có velocity thật. Đây là phase quan trọng nhất, đừng rút gọn.

- [x] `adapters/google_suggest.py`
- [x] `adapters/bing_suggest.py`
- [ ] `adapters/pinterest_suggest.py`
- [ ] `adapters/pinterest_trends.py` — Playwright, và **backfill 52 tuần lịch sử**
- [x] `core/ratelimit.py` — token bucket theo từng source
- [x] `pipeline/metrics.py` — velocity_7d, accel, n_sources, ghi `term_metrics_daily`
- [x] APScheduler: collect 02:00, metrics 03:00
- [x] Trang HTML thô liệt kê top term theo accel

**Acceptance**
- Backfill Pinterest xong thì `term_metrics_daily` có dữ liệu lùi ≥ 26 tuần
- Velocity tính đúng: seed một chuỗi tăng tuyến tính giả lập, kiểm tra slope khớp
- Rate limiter chặn được: giả lập 100 request Pinterest trong 1 phút, không có request nào
  vượt trần ghi trong `docs/SOURCES.md`
- Một adapter raise exception thì lượt collect vẫn hoàn tất với các nguồn còn lại

---

## Phase 2 — Scoring + calendar (1 tuần)

Mục tiêu: biết term nào đáng làm, và biết làm vào lúc nào.

- [ ] `pipeline/enrich.py` — đếm số listing cạnh tranh cho top 100 term/ngày → `saturation_score`
- [ ] Calendar engine: bảng `occasions` (dịp, peak_months, lead_weeks), join với seed
- [ ] Two-axis scoring: `momentum` và `opportunity`, lưu cả hai, không gộp thành một số
- [ ] Etsy CSV importer (`scanner import-etsy --file x.csv`) — KHÔNG scraper
- [ ] Dashboard: scatter plot 4 góc phần tư, filter theo niche và risk_tier

**Acceptance**
- Calendar engine trả đúng: hỏi "hôm nay nên sản xuất gì cho mùa cưới" vào tháng 12 thì
  ra các seed có peak_months 5-8 với lead 8-12 tuần
- Term bão hoà cao bị đẩy xuống góc opportunity thấp dù momentum cao
- Enrich không vượt quá 100 lookup/ngày

---

## Phase 3 — Risk gate (1 tuần)

Đọc `docs/RISK_POLICY.md` trước khi bắt đầu. Không rút gọn phase này để chạy nhanh hơn.

- [ ] Lớp 1: blocklist regex, load từ `data/blocklist.yaml`
- [ ] Lớp 2: USPTO lookup, exact phrase + normalized, lọc class 25, cache 30 ngày
- [ ] Lớp 3: LLM origin classification
- [ ] Lớp 4: trạng thái chờ người duyệt trong dashboard
- [ ] Ghi `risk_flags`, enforce fail-closed ở `pipeline/brief.py`

**Acceptance**
- Term chứa tên franchise trong blocklist → `blocked`, không bao giờ tới bước brief
- Term T3 (political) không bao giờ đạt `approved` mà không có `human_approved_by`
- USPTO API down → term rơi vào `review`, KHÔNG rơi vào `pass`
- Test bộ 20 cụm đã biết là dính nhãn hiệu: bắt được ≥ 18

---

## Phase 4 — Design brief + export (3-4 ngày)

Đọc `docs/DESIGN_BRIEF_SPEC.md`. Đây là output cuối cùng của cả hệ thống.

- [ ] Pydantic model cho `design_brief` khớp schema trong spec
- [ ] `pipeline/brief.py` — LLM sinh brief, Batch API, validate, retry 1 lần
- [ ] `pipeline/render.py` — brief → image prompt. **Code thuần, không LLM.**
      Template theo product_type, HARD_NEGATIVE dùng chung
- [ ] Nhánh typography-only: `art_layer.enabled=false` thì bỏ qua model ảnh
- [ ] Dashboard: duyệt/từ chối, export JSON brief
- [ ] Bảng `design_briefs` lưu brief dạng JSONB để query được

**Acceptance**
- 3 brief mẫu trong spec tái tạo được đúng qua renderer, prompt output khớp
- Brief T2/T3 không export được nếu chưa có `human_approved_by`
- Query được: `SELECT art_layer->>'style', COUNT(*) FROM design_briefs GROUP BY 1`
- LLM trả JSON sai schema 2 lần liên tiếp → `status=llm_failed`, không crash job

---

## Phase 5 — Vòng phản hồi (sau khi có 30 ngày dữ liệu)

- [ ] Bảng `sales`, importer từ Shopify/Amazon/Walmart report
- [ ] View tương quan: style / emotional_angle / arrangement / occasion vs doanh số
- [ ] Điều chỉnh trọng số scoring theo dữ liệu thật

---

## Việc KHÔNG nằm trong scope

- Sinh ảnh (đã có pipeline riêng, hệ thống này chỉ xuất brief)
- Upload listing lên marketplace (đã có pipeline riêng)
- Reddit adapter — giá trị thấp với ba niche core, để sau Phase 5
- Auth nhiều người dùng — một người dùng, chạy nội bộ
