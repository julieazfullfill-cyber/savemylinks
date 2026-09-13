"""Integration test cho pipeline collect. Cần Postgres đã migrate; không có thì skip.

Không gọi network: adapter stub trả payload lấy từ tests/fixtures/.
"""

from typing import Any, ClassVar

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.adapters import REGISTRY
from scanner.adapters.amazon_suggest import AmazonSuggestAdapter
from scanner.adapters.base import RawItem, daily_external_id, utcnow
from scanner.core.models import RawItem as RawItemRow
from scanner.core.models import Term, TermObservation
from scanner.core.ratelimit import RateLimitConfig
from scanner.core.seeds import SeedRow, sync_seeds
from scanner.pipeline.collect import collect_source

pytestmark = pytest.mark.db

STUB_PAYLOAD: dict[str, Any] = {
    "suggestions": [
        {"value": "Bridesmaid Proposal Box!", "type": "KEYWORD"},
        {"value": "bridesmaid proposal box", "type": "KEYWORD"},
        {"value": "gift for bridesmaid", "type": "KEYWORD"},
        {"value": "bridesmaid gift", "type": "KEYWORD"},
        {"value": "bridesmaid robe set", "type": "KEYWORD"},
    ]
}


class StubAdapter(AmazonSuggestAdapter):
    """Cùng logic extract, nhưng fetch trả fixture thay vì gọi mạng."""

    name: ClassVar[str] = "stub_suggest"
    kind: ClassVar[str] = "autocomplete"
    default_rate_limit: ClassVar[RateLimitConfig] = RateLimitConfig(
        requests=1000, per_seconds=1.0, burst=50
    )
    default_config: ClassVar[dict[str, Any]] = {"endpoint": "stub://suggest"}

    async def fetch(self, seed: str) -> list[RawItem]:
        return [
            RawItem(
                external_id=daily_external_id(self.name, "stub://suggest", seed),
                payload=STUB_PAYLOAD,
                fetched_at=utcnow(),
                seed=seed,
            )
        ]


class BrokenAdapter(StubAdapter):
    name: ClassVar[str] = "broken_suggest"

    async def fetch(self, seed: str) -> list[RawItem]:
        raise RuntimeError("nguồn chết")


@pytest.fixture
def stub_registered(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(REGISTRY, StubAdapter.name, StubAdapter)
    monkeypatch.setitem(REGISTRY, BrokenAdapter.name, BrokenAdapter)


async def seed_two_wedding_seeds(session: AsyncSession) -> None:
    await sync_seeds(
        session,
        [
            SeedRow(seed="bridesmaid proposal box", niche="wedding", risk_tier="T0"),
            SeedRow(seed="wedding welcome sign", niche="wedding", risk_tier="T0"),
        ],
    )
    await session.commit()


async def count(session: AsyncSession, model: Any) -> int:
    return int(await session.scalar(select(func.count()).select_from(model)) or 0)


async def test_collect_writes_raw_and_observations(
    db_session: AsyncSession, stub_registered: None
) -> None:
    await seed_two_wedding_seeds(db_session)

    stats = await collect_source(StubAdapter.name, niches=["wedding"])

    assert stats.seeds == 2
    assert stats.fetched == 2
    assert stats.failures == 0
    assert await count(db_session, RawItemRow) == 2
    # 5 gợi ý mỗi seed, nhưng bốn cái đầu gộp thành 2 term -> 3 term riêng biệt.
    assert await count(db_session, TermObservation) == 10
    assert await count(db_session, Term) == 3


async def test_rerun_same_day_creates_no_duplicate_rows(
    db_session: AsyncSession, stub_registered: None
) -> None:
    await seed_two_wedding_seeds(db_session)

    await collect_source(StubAdapter.name, niches=["wedding"])
    raw_before = await count(db_session, RawItemRow)
    obs_before = await count(db_session, TermObservation)

    second = await collect_source(StubAdapter.name, niches=["wedding"])

    assert second.duplicates == 2
    assert second.fetched == 0
    assert await count(db_session, RawItemRow) == raw_before
    assert await count(db_session, TermObservation) == obs_before


async def test_case_and_word_order_variants_share_one_term(
    db_session: AsyncSession, stub_registered: None
) -> None:
    await seed_two_wedding_seeds(db_session)
    await collect_source(StubAdapter.name, niches=["wedding"])

    ids = {
        text: await db_session.scalar(select(Term.id).where(Term.text_norm == text))
        for text in ("bridesmaid proposal box", "gift for bridesmaid")
    }
    assert all(v is not None for v in ids.values())

    # "bridesmaid gift" gộp vào term "gift for bridesmaid" qua text_key.
    merged = await db_session.scalar(select(Term.id).where(Term.text_norm == "bridesmaid gift"))
    assert merged is None

    display = await db_session.scalar(
        select(Term.text_display).where(Term.text_norm == "bridesmaid proposal box")
    )
    assert display == "Bridesmaid Proposal Box!"


async def test_failing_adapter_does_not_break_the_run(
    db_session: AsyncSession, stub_registered: None
) -> None:
    await seed_two_wedding_seeds(db_session)

    stats = await collect_source(BrokenAdapter.name, niches=["wedding"])

    assert stats.failures == 2
    assert stats.fetched == 0
    assert await count(db_session, RawItemRow) == 0
