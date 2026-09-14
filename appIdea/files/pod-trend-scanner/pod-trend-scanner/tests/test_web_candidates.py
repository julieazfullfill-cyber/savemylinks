"""Integration test cho trang scatter momentum/opportunity. Cần Postgres đã migrate;
skip nếu không có. Dùng httpx.AsyncClient + ASGITransport — xem ghi chú
tests/test_web_app.py về lý do không dùng starlette TestClient đồng bộ.
"""

from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import Candidate, RawItem, Seed, Source, Term, TermObservation
from scanner.web.app import app

pytestmark = pytest.mark.db


async def get(path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


async def seed_scatter_data(session: AsyncSession) -> None:
    source = Source(name="amazon_suggest", kind="autocomplete", config={})
    session.add(source)
    seed_wedding = Seed(seed="wedding sign", niche="wedding", risk_tier="T0")
    seed_pop = Seed(seed="funny movie quote shirt", niche="pop_culture", risk_tier="T2")
    session.add_all([seed_wedding, seed_pop])
    await session.flush()

    raw = RawItem(source_id=source.id, external_id="x1", payload={})
    session.add(raw)
    await session.flush()

    high_both = Term(
        text_norm="high momentum high opportunity",
        text_key="high momentum high opportunity",
        text_display="High Momentum High Opportunity",
        niche="wedding",
    )
    low_opportunity = Term(
        text_norm="high momentum low opportunity",
        text_key="high momentum low opportunity",
        text_display="High Momentum Low Opportunity",
        niche="pop_culture",
    )
    not_enriched = Term(
        text_norm="not yet enriched",
        text_key="not yet enriched",
        text_display="Not Yet Enriched",
        niche="wedding",
    )
    session.add_all([high_both, low_opportunity, not_enriched])
    await session.flush()

    session.add_all(
        [
            TermObservation(
                term_id=high_both.id,
                source_id=source.id,
                seed_id=seed_wedding.id,
                observed_at=datetime.now(UTC),
                rank=1,
                raw_item_id=raw.id,
            ),
            TermObservation(
                term_id=low_opportunity.id,
                source_id=source.id,
                seed_id=seed_pop.id,
                observed_at=datetime.now(UTC),
                rank=1,
                raw_item_id=raw.id,
            ),
        ]
    )
    session.add_all(
        [
            Candidate(term_id=high_both.id, momentum=Decimal("0.9"), opportunity=Decimal("0.8")),
            Candidate(
                term_id=low_opportunity.id, momentum=Decimal("0.9"), opportunity=Decimal("0.1")
            ),
            Candidate(term_id=not_enriched.id, momentum=Decimal("0.7"), opportunity=None),
        ]
    )
    await session.commit()


async def test_candidates_page_lists_only_fully_scored_candidates(
    db_session: AsyncSession,
) -> None:
    await seed_scatter_data(db_session)

    response = await get("/candidates")

    assert response.status_code == 200
    body = response.text
    assert "High Momentum High Opportunity" in body
    assert "High Momentum Low Opportunity" in body
    assert "Not Yet Enriched" not in body  # opportunity=None -> không vẽ được


async def test_candidates_page_filters_by_niche(db_session: AsyncSession) -> None:
    await seed_scatter_data(db_session)

    response = await get("/candidates?niche=wedding")

    body = response.text
    assert "High Momentum High Opportunity" in body
    assert "High Momentum Low Opportunity" not in body


async def test_candidates_page_filters_by_risk_tier(db_session: AsyncSession) -> None:
    await seed_scatter_data(db_session)

    response = await get("/candidates?risk_tier=T2")

    body = response.text
    assert "High Momentum Low Opportunity" in body
    assert "High Momentum High Opportunity" not in body


async def test_candidates_page_handles_empty_state(db_session: AsyncSession) -> None:
    response = await get("/candidates")

    assert response.status_code == 200
    assert "0 candidate" in response.text


async def test_candidates_page_niche_dropdown_lists_distinct_niches(
    db_session: AsyncSession,
) -> None:
    await seed_scatter_data(db_session)

    response = await get("/candidates")

    body = response.text
    assert '<option value="wedding"' in body
    assert '<option value="pop_culture"' in body
