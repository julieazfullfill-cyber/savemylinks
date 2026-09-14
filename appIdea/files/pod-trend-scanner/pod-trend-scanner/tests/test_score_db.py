"""Integration test cho pipeline/score.py. Cần Postgres đã migrate; không có thì skip."""

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import Candidate, Term, TermEnrichment, TermMetricsDaily
from scanner.pipeline.score import score_candidates

pytestmark = pytest.mark.db

TODAY = date(2026, 9, 14)


async def make_term(
    session: AsyncSession,
    text: str,
    *,
    accel: float,
    n_sources: int = 2,
    saturation_score: float | None = None,
    commercial_signal: bool | None = None,
) -> int:
    term = Term(
        text_norm=text,
        text_key=text,
        text_display=text,
        niche="wedding",
        first_seen_at=datetime.now(UTC),
    )
    session.add(term)
    await session.flush()
    session.add(
        TermMetricsDaily(
            term_id=term.id,
            date=TODAY,
            value_norm=Decimal("50"),
            accel=Decimal(str(accel)),
            n_sources=n_sources,
        )
    )
    if saturation_score is not None:
        session.add(
            TermEnrichment(
                term_id=term.id,
                competing_listings=100,
                saturation_score=Decimal(str(saturation_score)),
                commercial_signal=bool(commercial_signal),
                checked_at=datetime.now(UTC),
            )
        )
    await session.commit()
    return int(term.id)


async def get_candidate(session: AsyncSession, term_id: int) -> Candidate:
    return (
        await session.execute(select(Candidate).where(Candidate.term_id == term_id))
    ).scalar_one()


async def test_saturated_term_pushed_to_low_opportunity_despite_high_momentum(
    db_session: AsyncSession,
) -> None:
    # Acceptance: term bão hoà cao bị đẩy xuống góc opportunity thấp dù momentum cao.
    saturated_id = await make_term(
        db_session,
        "saturated high momentum term",
        accel=50.0,
        n_sources=4,
        saturation_score=0.95,
        commercial_signal=True,
    )
    fresh_id = await make_term(
        db_session,
        "fresh high momentum term",
        accel=50.0,
        n_sources=4,
        saturation_score=0.05,
        commercial_signal=True,
    )

    await score_candidates(db_session)
    await db_session.commit()

    saturated = await get_candidate(db_session, saturated_id)
    fresh = await get_candidate(db_session, fresh_id)

    assert saturated.momentum == fresh.momentum  # cùng accel/n_sources/first_seen_at
    assert saturated.opportunity is not None and fresh.opportunity is not None
    assert saturated.opportunity < fresh.opportunity  # bão hoà -> opportunity thấp hơn hẳn
    # 0.6*(1-0.95)+0.4*1 = 0.43 theo đúng công thức DATA_MODEL.md — thấp hơn hẳn fresh
    # (0.97) dù cùng momentum, nhưng không tụt xuống 0 vì commercial_signal vẫn đóng góp 0.4.
    assert saturated.opportunity == Decimal("0.43")
    assert fresh.opportunity == Decimal("0.97")


async def test_gate_requires_positive_accel_and_at_least_two_sources(
    db_session: AsyncSession,
) -> None:
    negative_accel_id = await make_term(db_session, "declining term", accel=-5.0, n_sources=3)
    single_source_id = await make_term(db_session, "single source term", accel=10.0, n_sources=1)
    qualifying_id = await make_term(db_session, "qualifying term", accel=10.0, n_sources=2)

    await score_candidates(db_session)
    await db_session.commit()

    ids_with_candidates = {
        c.term_id for c in (await db_session.execute(select(Candidate))).scalars().all()
    }
    assert qualifying_id in ids_with_candidates
    assert negative_accel_id not in ids_with_candidates
    assert single_source_id not in ids_with_candidates


async def test_opportunity_is_null_when_not_yet_enriched(db_session: AsyncSession) -> None:
    term_id = await make_term(db_session, "not enriched yet", accel=10.0, n_sources=2)

    await score_candidates(db_session)
    await db_session.commit()

    candidate = await get_candidate(db_session, term_id)
    assert candidate.momentum is not None
    assert candidate.opportunity is None


async def test_rerun_updates_pending_candidate_instead_of_duplicating(
    db_session: AsyncSession,
) -> None:
    term_id = await make_term(db_session, "rescored term", accel=5.0, n_sources=2)

    first = await score_candidates(db_session)
    await db_session.commit()
    assert first.new_candidates == 1

    second = await score_candidates(db_session)
    await db_session.commit()

    assert second.new_candidates == 0
    assert second.updated_candidates == 1
    rows = (
        await db_session.execute(select(Candidate).where(Candidate.term_id == term_id))
    ).scalars().all()
    assert len(rows) == 1  # không tạo thêm dòng trùng


async def test_resolved_candidate_gets_a_new_row_not_overwritten(
    db_session: AsyncSession,
) -> None:
    term_id = await make_term(db_session, "re-qualifying term", accel=5.0, n_sources=2)
    await score_candidates(db_session)
    await db_session.commit()

    old = await get_candidate(db_session, term_id)
    old.status = "rejected"
    await db_session.commit()

    stats = await score_candidates(db_session)
    await db_session.commit()

    assert stats.new_candidates == 1  # dòng mới, không đụng dòng đã rejected
    rows = (
        await db_session.execute(select(Candidate).where(Candidate.term_id == term_id))
    ).scalars().all()
    assert len(rows) == 2
    statuses = {r.status for r in rows}
    assert statuses == {"rejected", "pending"}


async def test_no_qualifying_terms_returns_zero_stats(db_session: AsyncSession) -> None:
    stats = await score_candidates(db_session)
    assert stats.scored == 0
    assert stats.new_candidates == 0
