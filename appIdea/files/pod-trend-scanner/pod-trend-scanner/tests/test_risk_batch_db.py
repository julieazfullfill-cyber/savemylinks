"""Integration test cho run_risk_gate_for_pending_candidates(). Cần Postgres đã
migrate; không có thì skip. Không gọi mạng thật (không có USPTO/ANTHROPIC key)."""

from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.config import get_settings
from scanner.core.models import Candidate, Term
from scanner.pipeline.risk import run_risk_gate_for_pending_candidates

pytestmark = pytest.mark.db


@pytest.fixture(autouse=True)
def no_external_keys(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    get_settings.cache_clear()
    monkeypatch.delenv("USPTO_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    yield
    get_settings.cache_clear()


async def make_pending_candidate(session: AsyncSession, text: str) -> int:
    term = Term(text_norm=text, text_key=text, text_display=text)
    session.add(term)
    await session.flush()
    candidate = Candidate(term_id=term.id, momentum=Decimal("0.5"))
    session.add(candidate)
    await session.commit()
    return int(candidate.id)


async def test_batch_only_processes_pending_unknown_risk_candidates(
    db_session: AsyncSession,
) -> None:
    pending_id = await make_pending_candidate(db_session, "brand new candidate")

    already_scored = Term(
        text_norm="already scored", text_key="already scored", text_display="already scored"
    )
    db_session.add(already_scored)
    await db_session.flush()
    scored_candidate = Candidate(term_id=already_scored.id, risk_level="low", status="pending")
    db_session.add(scored_candidate)
    await db_session.commit()

    stats = await run_risk_gate_for_pending_candidates(db_session)
    await db_session.commit()

    assert stats.checked == 1
    updated = await db_session.get(Candidate, pending_id)
    assert updated is not None and updated.risk_level != "unknown"
    unchanged = await db_session.get(Candidate, scored_candidate.id)
    assert unchanged is not None and unchanged.risk_level == "low"  # không đụng vào


async def test_batch_respects_limit(db_session: AsyncSession) -> None:
    for i in range(5):
        await make_pending_candidate(db_session, f"batch term {i}")

    stats = await run_risk_gate_for_pending_candidates(db_session, limit=2)
    await db_session.commit()

    assert stats.checked == 2


async def test_batch_sets_risk_level_and_returns_breakdown(db_session: AsyncSession) -> None:
    await make_pending_candidate(db_session, "star wars mug")  # blocklist -> blocked
    await make_pending_candidate(db_session, "generic candidate term")  # T2 default -> review

    stats = await run_risk_gate_for_pending_candidates(db_session)
    await db_session.commit()

    assert stats.checked == 2
    assert stats.blocked == 1
    assert stats.review == 1

    rows = (await db_session.execute(select(Candidate))).scalars().all()
    levels = {r.risk_level for r in rows}
    assert levels == {"blocked", "review"}


async def test_empty_queue_returns_zero_stats(db_session: AsyncSession) -> None:
    stats = await run_risk_gate_for_pending_candidates(db_session)
    assert stats.checked == 0
