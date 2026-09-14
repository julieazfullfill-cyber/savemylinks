"""Integration test cho nút duyệt/từ chối trên /review (POST /candidates/{id}/approve
|reject). Cần Postgres đã migrate; skip nếu không có."""

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import Candidate, RawItem, Seed, Source, Term, TermObservation
from scanner.web.app import app

pytestmark = pytest.mark.db


async def post(path: str, data: dict[str, str]) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", follow_redirects=False
    ) as client:
        return await client.post(path, data=data)


async def make_candidate_with_tier(
    session: AsyncSession, text: str, risk_tier: str, risk_level: str = "review"
) -> Candidate:
    from datetime import UTC, datetime

    seed = Seed(seed=text, niche="wedding", risk_tier=risk_tier)
    session.add(seed)
    await session.flush()
    source = Source(name="test_source_review_action", kind="autocomplete", config={})
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


async def test_approve_t0_without_by_succeeds(db_session: AsyncSession) -> None:
    candidate = await make_candidate_with_tier(db_session, "t0 term approve", "T0", "low")

    response = await post(f"/candidates/{candidate.id}/approve", {"by": ""})

    assert response.status_code == 303
    assert response.headers["location"] == "/review"
    await db_session.refresh(candidate)
    assert candidate.status == "approved"


async def test_approve_t2_without_by_fails_with_error_redirect(db_session: AsyncSession) -> None:
    candidate = await make_candidate_with_tier(db_session, "t2 term approve", "T2", "review")

    response = await post(f"/candidates/{candidate.id}/approve", {"by": ""})

    assert response.status_code == 303
    assert response.headers["location"].startswith("/review?error=")
    await db_session.refresh(candidate)
    assert candidate.status == "pending"  # không approve được, không có đường tắt


async def test_approve_t2_with_by_succeeds(db_session: AsyncSession) -> None:
    candidate = await make_candidate_with_tier(db_session, "t2 term approve ok", "T2", "review")

    response = await post(f"/candidates/{candidate.id}/approve", {"by": "admin@example.com"})

    assert response.status_code == 303
    assert response.headers["location"] == "/review"
    await db_session.refresh(candidate)
    assert candidate.status == "approved"
    assert candidate.approved_by == "admin@example.com"


async def test_reject_sets_status_rejected(db_session: AsyncSession) -> None:
    candidate = await make_candidate_with_tier(db_session, "term to reject", "T0", "review")

    response = await post(f"/candidates/{candidate.id}/reject", {"by": "someone"})

    assert response.status_code == 303
    assert response.headers["location"] == "/review"
    await db_session.refresh(candidate)
    assert candidate.status == "rejected"


async def test_approve_missing_candidate_redirects_with_error(db_session: AsyncSession) -> None:
    response = await post("/candidates/999999999/approve", {"by": "x"})
    assert response.status_code == 303
    assert response.headers["location"].startswith("/review?error=")
