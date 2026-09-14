"""Bước enrich: đếm số listing cạnh tranh cho top N term/ngày -> `term_enrichment`.

Nguồn: trang search HTML công khai của Amazon (`amazon.com/s?k=<term>`), đọc số
"results for" trong `<h2>` — KHÔNG phải API, không cần key, đã kiểm bằng request thật
(2026-09-14), 3 dạng response thật:

    "No results for your search query."          -> 0
    "27 results for"                              -> đếm chính xác, số nhỏ
    "1-48 of over 3,000 results for"              -> đếm gần đúng (Amazon làm tròn),
                                                      số lớn luôn có "over"

Parse bằng regex trên HTML thô, không dùng thư viện parser mới (tránh phải xin thêm
dependency) — pattern hẹp, đã xác nhận ổn định qua 3 request thật khác nhau. Xem
fixture tests/fixtures/amazon_search_*.html (đã cắt còn phần liên quan, giữ nguyên
markup thật).

`commercial_signal` KHÔNG gọi thêm nguồn nào — suy ra từ dữ liệu ĐÃ CÓ: term có từng
xuất hiện trong observation của `amazon_suggest` không (rule 9: LLM/nguồn không phát
hiện trend, số liệu đã thu thập làm việc đó).

`saturation_score` (0-1): log-scale trên `competing_listings`, mốc "bão hoà hoàn toàn"
đặt ở 50,000 listing (khớp trực giác: vài chục nghìn listing cạnh tranh cho một cụm từ
ngách là gần như không còn cửa). Công thức có thể đổi — term_enrichment tính lại được
từ competing_listings, không cần chạy lại HTTP.
"""

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from math import log1p

import httpx
from sqlalchemy import exists, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.config import get_settings
from scanner.core.log import get_logger
from scanner.core.models import Source, Term, TermEnrichment, TermMetricsDaily, TermObservation
from scanner.core.ratelimit import RateLimitConfig, RateLimiter

log = get_logger(__name__)

SEARCH_URL = "https://www.amazon.com/s"
DEFAULT_TOP_N = 100
CACHE_DAYS = 7  # không check lại term đã check trong 7 ngày qua, tiết kiệm ngân sách 100/ngày
SATURATION_REFERENCE = 50_000  # competing_listings ở mức này coi như bão hoà hoàn toàn (score=1)
COMMERCIAL_SOURCE_NAME = "amazon_suggest"

# Thứ tự quan trọng: kiểm tra "không có kết quả" trước, rồi khoảng gần đúng, rồi chính xác.
_NO_RESULTS_RE = re.compile(r"No results for your search query", re.IGNORECASE)
_RANGE_COUNT_RE = re.compile(
    r">\s*[\d,]+\s*-\s*[\d,]+\s+of\s+(?:over\s+)?([\d,]+)\s+results?\s+for\s*<", re.IGNORECASE
)
_EXACT_COUNT_RE = re.compile(r">\s*([\d,]+)\s+results?\s+for\s*<", re.IGNORECASE)


class EnrichFetchError(Exception):
    """Không parse được số listing từ HTML — trang có thể đã đổi cấu trúc."""


def parse_competing_listings(html: str) -> int | None:
    """Trả None nếu không nhận diện được cấu trúc trang (không phải 0 kết quả thật)."""
    if _NO_RESULTS_RE.search(html):
        return 0
    match = _RANGE_COUNT_RE.search(html) or _EXACT_COUNT_RE.search(html)
    if match is None:
        return None
    return int(match.group(1).replace(",", ""))


def saturation_from_count(competing_listings: int) -> Decimal:
    """0-1, log-scale. 0 listing -> 0.0, >= SATURATION_REFERENCE listing -> gần 1.0."""
    if competing_listings <= 0:
        return Decimal("0")
    score = log1p(competing_listings) / log1p(SATURATION_REFERENCE)
    return Decimal(str(round(min(score, 1.0), 4)))


@dataclass
class EnrichStats:
    checked: int = 0
    skipped_cached: int = 0
    failures: int = 0
    top_n: int = DEFAULT_TOP_N

    def as_dict(self) -> dict[str, int]:
        return {
            "checked": self.checked,
            "skipped_cached": self.skipped_cached,
            "failures": self.failures,
            "top_n": self.top_n,
        }


async def _fetch_competing_listings(client: httpx.AsyncClient, term: str) -> int:
    settings = get_settings()
    response = await client.get(
        SEARCH_URL,
        params={"k": term},
        headers={
            "User-Agent": settings.http_user_agent,
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    response.raise_for_status()
    count = parse_competing_listings(response.text)
    if count is None:
        raise EnrichFetchError(f"không parse được số kết quả cho '{term}'")
    return count


async def _select_terms_to_enrich(
    session: AsyncSession, top_n: int, cache_days: int
) -> list[tuple[int, str]]:
    """Top N term theo accel (ngày gần nhất có metrics), bỏ qua term đã check gần đây."""
    latest_date = await session.scalar(select(func.max(TermMetricsDaily.date)))
    if latest_date is None:
        return []

    cache_cutoff = datetime.now(UTC) - timedelta(days=cache_days)
    stmt = (
        select(Term.id, Term.text_norm)
        .join(TermMetricsDaily, TermMetricsDaily.term_id == Term.id)
        .outerjoin(TermEnrichment, TermEnrichment.term_id == Term.id)
        .where(
            TermMetricsDaily.date == latest_date,
            (TermEnrichment.checked_at.is_(None)) | (TermEnrichment.checked_at < cache_cutoff),
        )
        .order_by(TermMetricsDaily.accel.desc().nulls_last(), TermMetricsDaily.value_norm.desc())
        .limit(top_n)
    )
    rows = (await session.execute(stmt)).all()
    return [(int(r.id), r.text_norm) for r in rows]


async def _has_commercial_signal(session: AsyncSession, term_id: int) -> bool:
    """Term có từng xuất hiện trong observation của amazon_suggest không — không gọi
    thêm nguồn nào, chỉ đọc dữ liệu đã thu thập."""
    stmt = select(
        exists().where(
            TermObservation.term_id == term_id,
            TermObservation.source_id == select(Source.id)
            .where(Source.name == COMMERCIAL_SOURCE_NAME)
            .scalar_subquery(),
        )
    )
    return bool(await session.scalar(stmt))


async def _upsert_enrichment(
    session: AsyncSession,
    term_id: int,
    competing_listings: int,
    commercial_signal: bool,
) -> None:
    stmt = pg_insert(TermEnrichment).values(
        term_id=term_id,
        competing_listings=competing_listings,
        saturation_score=saturation_from_count(competing_listings),
        commercial_signal=commercial_signal,
        checked_at=datetime.now(UTC),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[TermEnrichment.term_id],
        set_={
            "competing_listings": stmt.excluded.competing_listings,
            "saturation_score": stmt.excluded.saturation_score,
            "commercial_signal": stmt.excluded.commercial_signal,
            "checked_at": stmt.excluded.checked_at,
        },
    )
    await session.execute(stmt)


async def enrich_top_terms(
    session: AsyncSession,
    *,
    top_n: int = DEFAULT_TOP_N,
    cache_days: int = CACHE_DAYS,
    client: httpx.AsyncClient | None = None,
) -> EnrichStats:
    """Enrich tối đa `top_n` term/lượt chạy — đúng acceptance "không vượt quá 100
    lookup/ngày" (mặc định top_n=100, chạy 1 lần/ngày qua scheduler)."""
    stats = EnrichStats(top_n=top_n)
    terms = await _select_terms_to_enrich(session, top_n, cache_days)
    if not terms:
        log.info("enrich.no_terms_due")
        return stats

    rate_limit = RateLimiter(RateLimitConfig(requests=1, per_seconds=1.0, burst=1), name="enrich")
    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=15.0, follow_redirects=True)

    try:
        for term_id, term_text in terms:
            async with rate_limit:
                try:
                    competing = await _fetch_competing_listings(http_client, term_text)
                except Exception as exc:  # noqa: BLE001 - một term lỗi không được chặn cả lượt
                    log.warning("enrich.fetch_failed", term=term_text, error=str(exc))
                    stats.failures += 1
                    continue
            commercial_signal = await _has_commercial_signal(session, term_id)
            await _upsert_enrichment(session, term_id, competing, commercial_signal)
            stats.checked += 1
    finally:
        if owns_client:
            await http_client.aclose()

    log.info("enrich.done", **stats.as_dict())
    return stats
