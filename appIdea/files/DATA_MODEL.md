# DATA_MODEL.md

Postgres 16. Mọi timestamp là `timestamptz`, lưu UTC.

## Nguyên tắc

`raw_items` và `term_observations` là **event log bất biến**. Chỉ INSERT.
Mọi thứ khác là dẫn xuất và phải tính lại được từ hai bảng này. Công thức scoring
sẽ thay đổi liên tục trong 3 tháng đầu — kiến trúc này cho phép replay toàn bộ
lịch sử với công thức mới, thay vì mất dữ liệu mỗi lần đổi.

## Schema

```sql
CREATE TABLE sources (
  id          SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,          -- 'amazon_suggest'
  kind        TEXT NOT NULL,                 -- 'autocomplete' | 'trends' | 'marketplace' | 'import'
  config      JSONB NOT NULL DEFAULT '{}',   -- endpoint, rate limit, country
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seeds (
  id            SERIAL PRIMARY KEY,
  seed          TEXT NOT NULL,
  niche         TEXT NOT NULL,
  sub_niche     TEXT,
  risk_tier     TEXT NOT NULL CHECK (risk_tier IN ('T0','T1','T2','T3')),
  personalized  BOOLEAN NOT NULL DEFAULT false,
  intent        TEXT,                        -- 'gift' | 'self'
  peak_months   SMALLINT[] NOT NULL DEFAULT '{}',
  note          TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (seed, niche)
);

CREATE TABLE raw_items (
  id           BIGSERIAL PRIMARY KEY,
  source_id    INT NOT NULL REFERENCES sources(id),
  external_id  TEXT NOT NULL,                -- hash(seed + endpoint + date) nếu nguồn không có id
  payload      JSONB NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);

CREATE TABLE terms (
  id            BIGSERIAL PRIMARY KEY,
  text_norm     TEXT UNIQUE NOT NULL,        -- lowercase, sạch dấu câu
  text_key      TEXT NOT NULL,               -- token đã sort + bỏ stopword, dùng fuzzy dedupe
  text_display  TEXT NOT NULL,               -- bản gốc đẹp nhất từng thấy
  kind          TEXT NOT NULL DEFAULT 'keyword',
  niche         TEXT,                        -- gán từ seed sinh ra nó
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON terms (text_key);
CREATE INDEX ON terms (first_seen_at);

CREATE TABLE term_observations (
  id           BIGSERIAL PRIMARY KEY,
  term_id      BIGINT NOT NULL REFERENCES terms(id),
  source_id    INT NOT NULL REFERENCES sources(id),
  seed_id      INT REFERENCES seeds(id),     -- seed nào sinh ra observation này
  observed_at  TIMESTAMPTZ NOT NULL,
  rank         SMALLINT,                     -- vị trí trong danh sách gợi ý, 1 = cao nhất
  value        NUMERIC,                      -- volume/index nếu nguồn có
  raw_item_id  BIGINT NOT NULL REFERENCES raw_items(id)
);
CREATE INDEX ON term_observations (term_id, observed_at DESC);
CREATE INDEX ON term_observations (source_id, observed_at DESC);

CREATE TABLE term_metrics_daily (
  term_id      BIGINT NOT NULL REFERENCES terms(id),
  date         DATE NOT NULL,
  value_norm   NUMERIC NOT NULL,             -- 0-100, chuẩn hoá theo rank
  velocity_7d  NUMERIC,
  velocity_21d NUMERIC,
  accel        NUMERIC,
  n_sources    SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (term_id, date)
);

CREATE TABLE term_enrichment (
  term_id             BIGINT PRIMARY KEY REFERENCES terms(id),
  competing_listings  INT,
  saturation_score    NUMERIC,               -- 0-1, càng cao càng bão hoà
  commercial_signal   BOOLEAN DEFAULT false, -- có trong autocomplete marketplace không
  checked_at          TIMESTAMPTZ
);

CREATE TABLE occasions (
  id           SERIAL PRIMARY KEY,
  name         TEXT UNIQUE NOT NULL,         -- 'mothers_day_us'
  peak_months  SMALLINT[] NOT NULL,
  lead_weeks   SMALLINT NOT NULL,            -- sản xuất trước peak bao nhiêu tuần
  niches       TEXT[] NOT NULL
);

CREATE TABLE risk_flags (
  id          BIGSERIAL PRIMARY KEY,
  term_id     BIGINT REFERENCES terms(id),
  candidate_id BIGINT,
  layer       TEXT NOT NULL,                 -- 'blocklist' | 'uspto' | 'llm_origin'
  severity    TEXT NOT NULL,                 -- 'info' | 'review' | 'block'
  evidence    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE candidates (
  id            BIGSERIAL PRIMARY KEY,
  term_id       BIGINT NOT NULL REFERENCES terms(id),
  momentum      NUMERIC,
  opportunity   NUMERIC,
  risk_level    TEXT NOT NULL DEFAULT 'unknown',  -- 'low' | 'review' | 'blocked'
  status        TEXT NOT NULL DEFAULT 'pending',
  -- pending | approved | rejected | exported | llm_failed
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE design_briefs (
  id           BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES candidates(id),
  payload      JSONB NOT NULL,               -- design_brief đầy đủ
  image_prompt TEXT,                         -- do render.py sinh, null nếu typography-only
  exported_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON design_briefs USING GIN (payload);
```

## Chuẩn hoá term (`core/normalize.py`)

```python
STOPWORDS = {"for","the","a","an","with","and","to","of","in","on","my","your"}

def normalize(text: str) -> tuple[str, str]:
    s = unicodedata.normalize("NFKC", text).lower()
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    text_norm = s
    tokens = sorted(t for t in s.split() if t not in STOPWORDS)
    text_key = " ".join(tokens)
    return text_norm, text_key
```

`text_norm` để lookup chính xác. `text_key` để phát hiện "gift for bridesmaid" và
"bridesmaid gift" là cùng một thứ. Khi `text_key` trùng nhưng `text_norm` khác,
gộp về term đã tồn tại và giữ `text_display` của bản có rank tốt nhất.

## Công thức metrics

Chuẩn hoá theo rank thay vì theo giá trị thô, vì mỗi nguồn một đơn vị khác nhau:

```
value_norm = 100 * (1 - (rank - 1) / max_rank)
```

Nguồn có volume thật (Pinterest Trends) thì dùng percentile trong ngày.

```
velocity_7d  = hệ số góc hồi quy tuyến tính trên 7 điểm value_norm gần nhất
velocity_21d = tương tự, 21 điểm
accel        = velocity_7d - velocity_21d
```

Điểm vào hàng đợi: `accel > 0` **và** `n_sources >= 2`.
Volume tuyệt đối gần như vô dụng — cao nghĩa là đã muộn.

## Two-axis scoring

Lưu hai trục riêng, không gộp. Gộp thành một con số thì mất khả năng giải thích
vì sao một term được chọn.

```
momentum    = 0.5*norm(accel) + 0.3*norm(n_sources) + 0.2*recency(first_seen_at)
opportunity = 0.6*(1 - saturation_score) + 0.4*commercial_signal
```

Góc momentum cao + opportunity cao là hàng đợi ưu tiên.
Góc momentum cao + opportunity thấp là thứ mọi người đang đổ vào — bỏ.
