"""Integration test cho pipeline/calendar.py — join occasions với seeds thật qua DB.
Cần Postgres đã migrate; không có thì skip.
"""

from datetime import date

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import Occasion, Seed
from scanner.pipeline.calendar import production_calendar

pytestmark = pytest.mark.db


async def seed_occasions_and_seeds(session: AsyncSession) -> None:
    session.add_all(
        [
            Occasion(
                name="wedding_season_us",
                peak_months=[5, 6, 7, 8],
                lead_weeks=10,
                niches=["wedding"],
            ),
            Occasion(
                name="mothers_day_us",
                peak_months=[5],
                lead_weeks=8,
                niches=["custom_photo", "birthday"],
            ),
        ]
    )
    session.add_all(
        [
            Seed(seed="wedding welcome sign", niche="wedding", risk_tier="T0"),
            Seed(seed="bridesmaid proposal box", niche="wedding", risk_tier="T0"),
            Seed(seed="photo collage blanket", niche="custom_photo", risk_tier="T0"),
            Seed(seed="funny dad shirt", niche="general_humor", risk_tier="T1"),
        ]
    )
    await session.commit()


async def test_december_query_matches_wedding_season_acceptance_example(
    db_session: AsyncSession,
) -> None:
    await seed_occasions_and_seeds(db_session)

    items = await production_calendar(db_session, today=date(2026, 12, 15))

    wedding_items = [i for i in items if i.occasion == "wedding_season_us"]
    assert {i.seed for i in wedding_items} == {"wedding welcome sign", "bridesmaid proposal box"}
    for i in wedding_items:
        assert i.peak_months == (5, 6, 7, 8)
        assert 8 <= i.lead_weeks <= 12
        assert i.niche == "wedding"


async def test_query_too_early_for_wedding_season_returns_nothing_for_that_occasion(
    db_session: AsyncSession,
) -> None:
    await seed_occasions_and_seeds(db_session)

    items = await production_calendar(db_session, today=date(2026, 6, 1))

    assert not any(i.occasion == "wedding_season_us" for i in items)


async def test_niche_filter_excludes_other_niches(db_session: AsyncSession) -> None:
    await seed_occasions_and_seeds(db_session)

    items = await production_calendar(db_session, niche="wedding", today=date(2026, 12, 15))

    assert items
    assert all(i.niche == "wedding" for i in items)


async def test_disabled_seed_is_excluded(db_session: AsyncSession) -> None:
    await seed_occasions_and_seeds(db_session)
    disabled = Seed(
        seed="discontinued wedding item", niche="wedding", risk_tier="T0", enabled=False
    )
    db_session.add(disabled)
    await db_session.commit()

    items = await production_calendar(db_session, today=date(2026, 12, 15))

    assert "discontinued wedding item" not in {i.seed for i in items}


async def test_no_match_returns_empty_list(db_session: AsyncSession) -> None:
    await seed_occasions_and_seeds(db_session)

    # wedding_season_us đóng cửa sổ 2026-02-20, mothers_day_us đóng 2026-03-06 —
    # đầu tháng 4 thì cả hai đều đã trễ, occasion tiếp theo còn quá xa.
    items = await production_calendar(db_session, today=date(2026, 4, 1))

    assert items == []
