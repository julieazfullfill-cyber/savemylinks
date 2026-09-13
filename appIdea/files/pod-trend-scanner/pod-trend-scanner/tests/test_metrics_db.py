"""Integration test cho pipeline/metrics.py. Cần Postgres đã migrate; không có thì skip."""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import RawItem, Source, Term, TermMetricsDaily, TermObservation
from scanner.pipeline.metrics import list_observation_dates, recompute_history, run_metrics

pytestmark = pytest.mark.db

DAY0 = date(2026, 8, 1)


async def make_source(session: AsyncSession, name: str, kind: str = "autocomplete") -> int:
    stmt = (
        pg_insert(Source)
        .values(name=name, kind=kind, config={})
        .on_conflict_do_nothing(index_elements=[Source.name])
        .returning(Source.id)
    )
    source_id = await session.scalar(stmt)
    if source_id is None:
        source_id = await session.scalar(select(Source.id).where(Source.name == name))
    assert source_id is not None
    return int(source_id)


async def make_term(session: AsyncSession, text: str) -> int:
    term = Term(text_norm=text, text_key=text, text_display=text, niche="wedding")
    session.add(term)
    await session.flush()
    return int(term.id)


async def add_raw_item(session: AsyncSession, source_id: int, external_id: str) -> int:
    raw = RawItem(source_id=source_id, external_id=external_id, payload={})
    session.add(raw)
    await session.flush()
    return int(raw.id)


async def add_observation(
    session: AsyncSession,
    *,
    term_id: int,
    source_id: int,
    raw_item_id: int,
    day: date,
    rank: int | None = None,
    value: float | None = None,
    seed_id: int | None = None,
) -> None:
    session.add(
        TermObservation(
            term_id=term_id,
            source_id=source_id,
            seed_id=seed_id,
            observed_at=datetime(day.year, day.month, day.day, 5, tzinfo=UTC),
            rank=rank,
            value=Decimal(str(value)) if value is not None else None,
            raw_item_id=raw_item_id,
        )
    )


async def get_metrics_row(session: AsyncSession, term_id: int, day: date) -> Any:
    return (
        await session.execute(
            select(TermMetricsDaily).where(
                TermMetricsDaily.term_id == term_id, TermMetricsDaily.date == day
            )
        )
    ).scalar_one()


async def test_rank_based_value_norm_and_best_of_multiple_sources(
    db_session: AsyncSession,
) -> None:
    amazon_id = await make_source(db_session, "amazon_suggest")
    google_id = await make_source(db_session, "google_suggest")
    term_id = await make_term(db_session, "wedding sign")

    # Amazon: rank 1/5 -> value_norm 100. Google: rank 3/10 -> value_norm thấp hơn.
    raw_a = await add_raw_item(db_session, amazon_id, "a1")
    raw_g = await add_raw_item(db_session, google_id, "g1")
    for rank in range(1, 6):
        await add_observation(
            db_session, term_id=term_id, source_id=amazon_id, raw_item_id=raw_a, day=DAY0, rank=rank
        )
    for rank in range(1, 11):
        await add_observation(
            db_session, term_id=term_id, source_id=google_id, raw_item_id=raw_g, day=DAY0, rank=rank
        )
    await db_session.commit()

    stats = await run_metrics(db_session, DAY0)
    await db_session.commit()

    assert stats.terms_scored == 1
    row = await get_metrics_row(db_session, term_id, DAY0)
    assert row.value_norm == Decimal("100")  # rank 1 ở cả hai nguồn -> MAX = 100
    assert row.n_sources == 2


async def test_trends_source_uses_percentile_not_rank(db_session: AsyncSession) -> None:
    trends_id = await make_source(db_session, "pinterest_trends", kind="trends")
    high_term = await make_term(db_session, "wedding guest book high")
    low_term = await make_term(db_session, "wedding guest book low")
    raw_id = await add_raw_item(db_session, trends_id, "t1")

    await add_observation(
        db_session, term_id=low_term, source_id=trends_id, raw_item_id=raw_id, day=DAY0, value=10
    )
    await add_observation(
        db_session, term_id=high_term, source_id=trends_id, raw_item_id=raw_id, day=DAY0, value=1000
    )
    await db_session.commit()

    await run_metrics(db_session, DAY0)
    await db_session.commit()

    low_row = await get_metrics_row(db_session, low_term, DAY0)
    high_row = await get_metrics_row(db_session, high_term, DAY0)
    assert low_row.value_norm < high_row.value_norm
    assert high_row.value_norm == Decimal("100")  # percentile cao nhất


async def test_velocity_is_zero_when_value_norm_stays_flat(db_session: AsyncSession) -> None:
    source_id = await make_source(db_session, "amazon_suggest")
    term_id = await make_term(db_session, "flat term")

    # 10 ngày liên tiếp, luôn rank 1 trong raw_item 11 gợi ý -> value_norm=100 mỗi ngày.
    for offset in range(10):
        day = DAY0 + timedelta(days=offset)
        raw_id = await add_raw_item(db_session, source_id, f"flat{offset}")
        await add_observation(
            db_session, term_id=term_id, source_id=source_id, raw_item_id=raw_id, day=day, rank=1
        )
        await add_observation(
            db_session,
            term_id=await make_term(db_session, f"flat filler {offset}"),
            source_id=source_id,
            raw_item_id=raw_id,
            day=day,
            rank=11,
        )
    await db_session.commit()

    for offset in range(10):
        await run_metrics(db_session, DAY0 + timedelta(days=offset))
    await db_session.commit()

    last_day = DAY0 + timedelta(days=9)
    row = await get_metrics_row(db_session, term_id, last_day)
    assert row.value_norm == Decimal("100")
    assert row.velocity_7d == pytest.approx(0.0)


async def test_velocity_on_a_truly_increasing_series(db_session: AsyncSession) -> None:
    source_id = await make_source(db_session, "amazon_suggest")
    term_id = await make_term(db_session, "accelerating term")

    # max_rank cố định = 100 (nhờ filler rank=100 trong cùng raw_item), rank của
    # term chính giảm dần 91->1 mỗi ngày -> value_norm tăng tuyến tính đều 15 điểm/ngày:
    # 10, 25, 40, 55, 70, 85, 100.
    ranks = [91, 76, 61, 46, 31, 16, 1]
    for offset, rank in enumerate(ranks):
        day = DAY0 + timedelta(days=offset)
        raw_id = await add_raw_item(db_session, source_id, f"acc{offset}")
        await add_observation(
            db_session, term_id=term_id, source_id=source_id, raw_item_id=raw_id, day=day, rank=rank
        )
        await add_observation(
            db_session,
            term_id=await make_term(db_session, f"filler {offset}"),
            source_id=source_id,
            raw_item_id=raw_id,
            day=day,
            rank=100,
        )
    await db_session.commit()

    for offset in range(len(ranks)):
        await run_metrics(db_session, DAY0 + timedelta(days=offset))
    await db_session.commit()

    last_day = DAY0 + timedelta(days=len(ranks) - 1)
    row = await get_metrics_row(db_session, term_id, last_day)
    assert row.value_norm == Decimal("100")
    assert row.velocity_7d is not None
    assert row.velocity_7d == pytest.approx(15.0, abs=0.01)  # slope khớp bước tăng đã seed


async def test_n_sources_counts_distinct_sources_only(db_session: AsyncSession) -> None:
    amazon_id = await make_source(db_session, "amazon_suggest")
    term_id = await make_term(db_session, "solo source term")
    raw_id = await add_raw_item(db_session, amazon_id, "solo1")
    await add_observation(
        db_session, term_id=term_id, source_id=amazon_id, raw_item_id=raw_id, day=DAY0, rank=1
    )
    await db_session.commit()

    await run_metrics(db_session, DAY0)
    await db_session.commit()

    row = await get_metrics_row(db_session, term_id, DAY0)
    assert row.n_sources == 1


async def test_run_metrics_is_idempotent(db_session: AsyncSession) -> None:
    source_id = await make_source(db_session, "amazon_suggest")
    term_id = await make_term(db_session, "idempotent term")
    raw_id = await add_raw_item(db_session, source_id, "idem1")
    await add_observation(
        db_session, term_id=term_id, source_id=source_id, raw_item_id=raw_id, day=DAY0, rank=1
    )
    await db_session.commit()

    first = await run_metrics(db_session, DAY0)
    await db_session.commit()
    second = await run_metrics(db_session, DAY0)
    await db_session.commit()

    assert first.terms_scored == second.terms_scored == 1
    count = await db_session.scalar(
        select(TermMetricsDaily.value_norm).where(
            TermMetricsDaily.term_id == term_id, TermMetricsDaily.date == DAY0
        )
    )
    assert count == Decimal("100")


async def test_recompute_history_covers_every_observation_date(db_session: AsyncSession) -> None:
    source_id = await make_source(db_session, "amazon_suggest")
    term_id = await make_term(db_session, "history term")
    for offset in [0, 2, 5]:
        day = DAY0 + timedelta(days=offset)
        raw_id = await add_raw_item(db_session, source_id, f"h{offset}")
        await add_observation(
            db_session, term_id=term_id, source_id=source_id, raw_item_id=raw_id, day=day, rank=1
        )
    await db_session.commit()

    dates = await list_observation_dates(db_session)
    assert dates == [DAY0, DAY0 + timedelta(days=2), DAY0 + timedelta(days=5)]

    results = await recompute_history(db_session)
    await db_session.commit()

    assert [r.date for r in results] == dates
    assert all(r.terms_scored == 1 for r in results)
