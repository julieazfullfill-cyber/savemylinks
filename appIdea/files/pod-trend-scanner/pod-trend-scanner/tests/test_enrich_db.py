"""Integration test cho pipeline/enrich.py. Cần Postgres đã migrate; không có thì skip.

Không gọi network thật: dùng httpx.MockTransport trả HTML cố định.
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import (
    RawItem,
    Source,
    Term,
    TermEnrichment,
    TermMetricsDaily,
    TermObservation,
)
from scanner.pipeline.enrich import enrich_top_terms

pytestmark = pytest.mark.db

TODAY = date(2026, 9, 14)


def mock_client(html_by_term: dict[str, str], default_html: str = "") -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        term = dict(request.url.params).get("k", "")
        html = html_by_term.get(term, default_html)
        return httpx.Response(200, text=html)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


OVER_HTML = '<h2 class="a-text-normal"><span>1-48 of over 3,000 results for</span></h2>'
EXACT_HTML = '<h2 class="a-text-normal"><span>27 results for</span></h2>'
ZERO_HTML = "<h2><span>No results for your search query. </span></h2>"


async def make_term_with_metrics(
    session: AsyncSession, text: str, accel: float, day: date = TODAY
) -> int:
    term = Term(text_norm=text, text_key=text, text_display=text, niche="wedding")
    session.add(term)
    await session.flush()
    session.add(
        TermMetricsDaily(
            term_id=term.id,
            date=day,
            value_norm=Decimal("50"),
            accel=Decimal(str(accel)),
            n_sources=1,
        )
    )
    await session.commit()
    return int(term.id)


async def test_enrich_writes_competing_listings_and_saturation(
    db_session: AsyncSession,
) -> None:
    term_id = await make_term_with_metrics(db_session, "high competition term", accel=10)
    client = mock_client({"high competition term": OVER_HTML})

    stats = await enrich_top_terms(db_session, top_n=10, client=client)
    await db_session.commit()
    await client.aclose()

    assert stats.checked == 1
    assert stats.failures == 0
    row = (
        await db_session.execute(
            select(TermEnrichment).where(TermEnrichment.term_id == term_id)
        )
    ).scalar_one()
    assert row.competing_listings == 3000
    assert row.saturation_score is not None
    assert row.checked_at is not None


async def test_enrich_selects_top_n_by_accel_descending(db_session: AsyncSession) -> None:
    low_id = await make_term_with_metrics(db_session, "low accel term", accel=1)
    high_id = await make_term_with_metrics(db_session, "high accel term", accel=99)
    client = mock_client(
        {"low accel term": EXACT_HTML, "high accel term": OVER_HTML}
    )

    # top_n=1 -> chỉ term có accel cao nhất được enrich.
    stats = await enrich_top_terms(db_session, top_n=1, client=client)
    await db_session.commit()
    await client.aclose()

    assert stats.checked == 1
    enriched_ids = {
        r.term_id for r in (await db_session.execute(select(TermEnrichment))).scalars().all()
    }
    assert enriched_ids == {high_id}
    assert low_id not in enriched_ids


async def test_enrich_respects_cache_and_skips_recently_checked(
    db_session: AsyncSession,
) -> None:
    term_id = await make_term_with_metrics(db_session, "cached term", accel=5)
    db_session.add(
        TermEnrichment(
            term_id=term_id,
            competing_listings=100,
            saturation_score=Decimal("0.5"),
            commercial_signal=False,
            checked_at=datetime.now(UTC) - timedelta(days=1),  # mới check hôm qua
        )
    )
    await db_session.commit()
    client = mock_client({"cached term": OVER_HTML})

    stats = await enrich_top_terms(db_session, top_n=10, cache_days=7, client=client)
    await client.aclose()

    assert stats.checked == 0  # bị bỏ qua vì cache 7 ngày


async def test_enrich_rechecks_after_cache_expires(db_session: AsyncSession) -> None:
    term_id = await make_term_with_metrics(db_session, "stale term", accel=5)
    db_session.add(
        TermEnrichment(
            term_id=term_id,
            competing_listings=100,
            saturation_score=Decimal("0.5"),
            commercial_signal=False,
            checked_at=datetime.now(UTC) - timedelta(days=10),  # quá hạn cache 7 ngày
        )
    )
    await db_session.commit()
    client = mock_client({"stale term": OVER_HTML})

    stats = await enrich_top_terms(db_session, top_n=10, cache_days=7, client=client)
    await db_session.commit()
    await client.aclose()

    assert stats.checked == 1
    row = (
        await db_session.execute(select(TermEnrichment).where(TermEnrichment.term_id == term_id))
    ).scalar_one()
    assert row.competing_listings == 3000  # cập nhật giá trị mới


async def test_enrich_caps_at_top_n_never_exceeding_it(db_session: AsyncSession) -> None:
    # Acceptance: "Enrich không vượt quá 100 lookup/ngày" — verify với top_n nhỏ hơn
    # số term có sẵn, đảm bảo không vượt quá.
    html_map: dict[str, str] = {}
    for i in range(10):
        text = f"term number {i}"
        await make_term_with_metrics(db_session, text, accel=float(i))
        html_map[text] = EXACT_HTML
    client = mock_client(html_map)

    stats = await enrich_top_terms(db_session, top_n=3, client=client)
    await client.aclose()

    assert stats.checked <= 3
    assert stats.top_n == 3


async def test_commercial_signal_true_when_term_seen_in_amazon_suggest(
    db_session: AsyncSession,
) -> None:
    source = Source(name="amazon_suggest", kind="autocomplete", config={})
    db_session.add(source)
    await db_session.flush()
    raw = RawItem(source_id=source.id, external_id="x1", payload={})
    db_session.add(raw)
    await db_session.flush()

    term_id = await make_term_with_metrics(db_session, "seen on amazon", accel=5)
    db_session.add(
        TermObservation(
            term_id=term_id,
            source_id=source.id,
            observed_at=datetime.now(UTC),
            rank=1,
            raw_item_id=raw.id,
        )
    )
    await db_session.commit()

    client = mock_client({"seen on amazon": OVER_HTML})
    await enrich_top_terms(db_session, top_n=10, client=client)
    await db_session.commit()
    await client.aclose()

    row = (
        await db_session.execute(select(TermEnrichment).where(TermEnrichment.term_id == term_id))
    ).scalar_one()
    assert row.commercial_signal is True


async def test_commercial_signal_false_when_never_seen_on_amazon(
    db_session: AsyncSession,
) -> None:
    term_id = await make_term_with_metrics(db_session, "never on amazon", accel=5)
    client = mock_client({"never on amazon": EXACT_HTML})

    await enrich_top_terms(db_session, top_n=10, client=client)
    await db_session.commit()
    await client.aclose()

    row = (
        await db_session.execute(select(TermEnrichment).where(TermEnrichment.term_id == term_id))
    ).scalar_one()
    assert row.commercial_signal is False


async def test_fetch_failure_for_one_term_does_not_block_others(
    db_session: AsyncSession,
) -> None:
    await make_term_with_metrics(db_session, "will fail", accel=10)
    ok_id = await make_term_with_metrics(db_session, "will succeed", accel=5)

    def handler(request: httpx.Request) -> httpx.Response:
        term = dict(request.url.params).get("k", "")
        if term == "will fail":
            return httpx.Response(500, text="server error")
        return httpx.Response(200, text=OVER_HTML)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    stats = await enrich_top_terms(db_session, top_n=10, client=client)
    await db_session.commit()
    await client.aclose()

    assert stats.failures == 1
    assert stats.checked == 1
    row = (
        await db_session.execute(select(TermEnrichment).where(TermEnrichment.term_id == ok_id))
    ).scalar_one()
    assert row.competing_listings == 3000


async def test_no_terms_with_metrics_returns_empty_stats(db_session: AsyncSession) -> None:
    stats = await enrich_top_terms(db_session, top_n=10)
    assert stats.checked == 0
    assert stats.failures == 0
