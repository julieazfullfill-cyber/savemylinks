"""Integration test cho POST /candidates/{id}/generate-brief|export-brief qua web.
Cần Postgres đã migrate; skip nếu không có. Không có ANTHROPIC_API_KEY trong test này
-> generate-brief luôn llm_failed (offline, không gọi mạng) — nhánh thành công của
generate_brief() đã test đầy đủ (mock httpx) ở tests/test_brief.py; ở đây chỉ test
việc web layer nối dây đúng + enforce fail-closed qua export."""

from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.config import get_settings
from scanner.core.models import Candidate, DesignBrief, RawItem, Seed, Source, Term, TermObservation
from scanner.pipeline.risk import approve_candidate
from scanner.web.app import app

pytestmark = pytest.mark.db


@pytest.fixture(autouse=True)
def reset_settings(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    get_settings.cache_clear()
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    yield
    get_settings.cache_clear()


async def post(path: str, data: dict[str, str] | None = None) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", follow_redirects=False
    ) as client:
        return await client.post(path, data=data or {})


async def make_candidate(
    session: AsyncSession, text: str, risk_tier: str = "T0", risk_level: str = "low"
) -> Candidate:
    seed = Seed(seed=text, niche="wedding", risk_tier=risk_tier)
    session.add(seed)
    await session.flush()
    source = Source(name="test_source_brief_action", kind="autocomplete", config={})
    session.add(source)
    await session.flush()
    raw = RawItem(source_id=source.id, external_id=f"raw-{text}", payload={})
    session.add(raw)
    await session.flush()
    term = Term(text_norm=text, text_key=text, text_display=text, niche="wedding")
    session.add(term)
    await session.flush()
    session.add(
        TermObservation(
            term_id=term.id,
            source_id=source.id,
            seed_id=seed.id,
            observed_at=datetime.now(UTC),
            rank=1,
            raw_item_id=raw.id,
        )
    )
    candidate = Candidate(term_id=term.id, risk_level=risk_level)
    session.add(candidate)
    await session.commit()
    return candidate


async def test_generate_brief_without_api_key_redirects_with_error(
    db_session: AsyncSession,
) -> None:
    candidate = await make_candidate(db_session, "no key wedding term")

    response = await post(f"/candidates/{candidate.id}/generate-brief")

    assert response.status_code == 303
    assert response.headers["location"].startswith(f"/terms/{candidate.term_id}?error=")
    await db_session.refresh(candidate)
    assert candidate.status == "llm_failed"


async def test_generate_brief_for_blocked_candidate_redirects_with_error(
    db_session: AsyncSession,
) -> None:
    candidate = await make_candidate(db_session, "blocked wedding term", risk_level="blocked")

    response = await post(f"/candidates/{candidate.id}/generate-brief")

    assert response.status_code == 303
    assert "error=" in response.headers["location"]


async def test_export_brief_without_any_brief_redirects_with_error(
    db_session: AsyncSession,
) -> None:
    candidate = await make_candidate(db_session, "term without brief")
    await approve_candidate(db_session, candidate, "T0", approved_by=None)
    await db_session.commit()

    response = await post(f"/candidates/{candidate.id}/export-brief")

    assert response.status_code == 303
    assert response.headers["location"].startswith(f"/terms/{candidate.term_id}?error=")


async def test_export_brief_without_approval_redirects_with_error(
    db_session: AsyncSession,
) -> None:
    candidate = await make_candidate(db_session, "unapproved t2 term", risk_tier="T2")
    db_session.add(DesignBrief(candidate_id=candidate.id, payload={"x": 1}, image_prompt="p"))
    await db_session.commit()

    response = await post(f"/candidates/{candidate.id}/export-brief")

    assert response.status_code == 303
    assert "error=" in response.headers["location"]


async def test_export_brief_succeeds_after_approval(db_session: AsyncSession) -> None:
    candidate = await make_candidate(db_session, "approved export term")
    db_session.add(
        DesignBrief(candidate_id=candidate.id, payload={"source": {"term": "x"}}, image_prompt="p")
    )
    await db_session.commit()
    await approve_candidate(db_session, candidate, "T0", approved_by=None)
    await db_session.commit()

    response = await post(f"/candidates/{candidate.id}/export-brief")

    assert response.status_code == 303
    assert response.headers["location"] == f"/terms/{candidate.term_id}"

    from sqlalchemy import select

    row = (
        await db_session.execute(
            select(DesignBrief).where(DesignBrief.candidate_id == candidate.id)
        )
    ).scalar_one()
    assert row.exported_at is not None
