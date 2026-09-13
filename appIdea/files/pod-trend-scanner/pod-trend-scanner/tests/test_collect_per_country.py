"""Integration test cho nhánh per_seed=False trong pipeline/collect.py (nguồn snapshot
theo quốc gia, ví dụ pinterest_trends). Cần Postgres đã migrate; không có thì skip.

Không gọi network: adapter stub trả payload cố định, không dùng Playwright thật.
"""

from datetime import UTC, datetime
from typing import Any, ClassVar

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.adapters import REGISTRY
from scanner.adapters.base import Observation, RawItem, SourceAdapter
from scanner.core.models import RawItem as RawItemRow
from scanner.core.models import Term, TermObservation
from scanner.core.ratelimit import RateLimitConfig
from scanner.core.seeds import SeedRow, sync_seeds
from scanner.pipeline.collect import collect_source

pytestmark = pytest.mark.db

FETCH_COUNT: dict[str, int] = {"n": 0}


class StubCountryAdapter(SourceAdapter):
    """Mô phỏng pinterest_trends: per_seed=False, trả 2 term cố định mỗi lần fetch."""

    name: ClassVar[str] = "stub_country_trends"
    kind: ClassVar[str] = "trends"
    per_seed: ClassVar[bool] = False
    default_rate_limit: ClassVar[RateLimitConfig] = RateLimitConfig(
        requests=1000, per_seconds=1.0, burst=50
    )
    default_config: ClassVar[dict[str, Any]] = {}

    async def fetch(self, seed: str) -> list[RawItem]:
        FETCH_COUNT["n"] += 1
        today = datetime.now(UTC).date().isoformat()
        return [
            RawItem(
                external_id=f"{self.name}|{today}",
                payload={"terms": ["trending topic one", "trending topic two"]},
                fetched_at=datetime.now(UTC),
                seed=None,
            )
        ]

    def extract(self, raw: RawItem) -> list[Observation]:
        now = datetime.now(UTC)
        return [Observation(text=t, observed_at=now, value=None) for t in raw.payload["terms"]]


@pytest.fixture
def stub_registered(monkeypatch: pytest.MonkeyPatch) -> None:
    FETCH_COUNT["n"] = 0
    monkeypatch.setitem(REGISTRY, StubCountryAdapter.name, StubCountryAdapter)


async def seed_many_wedding_seeds(session: AsyncSession, n: int = 5) -> None:
    await sync_seeds(
        session,
        [SeedRow(seed=f"wedding seed {i}", niche="wedding", risk_tier="T0") for i in range(n)],
    )
    await session.commit()


async def count(session: AsyncSession, model: Any) -> int:
    return int(await session.scalar(select(func.count()).select_from(model)) or 0)


async def test_per_country_source_calls_fetch_exactly_once(
    db_session: AsyncSession, stub_registered: None
) -> None:
    await seed_many_wedding_seeds(db_session, n=5)

    stats = await collect_source(StubCountryAdapter.name)

    assert FETCH_COUNT["n"] == 1  # không lặp qua 5 seed
    assert stats.seeds == 1
    assert stats.fetched == 1
    assert stats.observations == 2
    assert await count(db_session, RawItemRow) == 1
    assert await count(db_session, TermObservation) == 2


async def test_per_country_observations_have_no_seed_id_or_niche(
    db_session: AsyncSession, stub_registered: None
) -> None:
    await seed_many_wedding_seeds(db_session, n=3)
    await collect_source(StubCountryAdapter.name)

    obs = (await db_session.execute(select(TermObservation))).scalars().all()
    assert len(obs) == 2
    assert all(o.seed_id is None for o in obs)

    terms = (await db_session.execute(select(Term))).scalars().all()
    assert all(t.niche is None for t in terms)


async def test_per_country_rerun_same_day_creates_no_duplicate(
    db_session: AsyncSession, stub_registered: None
) -> None:
    await seed_many_wedding_seeds(db_session, n=3)
    await collect_source(StubCountryAdapter.name)
    raw_before = await count(db_session, RawItemRow)
    obs_before = await count(db_session, TermObservation)

    second = await collect_source(StubCountryAdapter.name)

    assert FETCH_COUNT["n"] == 2  # fetch vẫn được gọi (per_seed=False không cache), nhưng
    assert second.duplicates == 1  # external_id trùng -> raw_item không ghi thêm
    assert second.fetched == 0
    assert await count(db_session, RawItemRow) == raw_before
    assert await count(db_session, TermObservation) == obs_before


async def test_per_country_source_ignores_niche_and_limit_filters(
    db_session: AsyncSession, stub_registered: None
) -> None:
    """niches/limit không áp dụng cho nguồn per_seed=False — dữ liệu không phụ thuộc seed."""
    await seed_many_wedding_seeds(db_session, n=3)

    stats = await collect_source(StubCountryAdapter.name, niches=["birthday"], limit=1)

    assert stats.fetched == 1  # vẫn chạy, không bị lọc theo niche "birthday" (không seed nào)
