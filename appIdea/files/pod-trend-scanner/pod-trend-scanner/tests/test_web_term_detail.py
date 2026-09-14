"""Integration test cho /terms/{id} (chi tiết term) + action check-uspto/check-llm.
Cần Postgres đã migrate; skip nếu không có. Không có ANTHROPIC_API_KEY trong test này
-> check-llm luôn "review", verify đúng nhánh fail-closed thật (giống pattern
tests/test_risk_llm_origin.py)."""

from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.config import get_settings
from scanner.core.models import Candidate, RawItem, Seed, Source, Term, TermObservation
from scanner.web.app import app

pytestmark = pytest.mark.db


@pytest.fixture(autouse=True)
def reset_settings(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    get_settings.cache_clear()
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("USPTO_INDEX_COVERAGE_COMPLETE", "false")
    yield
    get_settings.cache_clear()


async def get(path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


async def post(path: str, data: dict[str, str] | None = None) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(path, data=data or {})


async def make_term(session: AsyncSession, text: str = "wedding sign personalized") -> Term:
    term = Term(text_norm=text, text_key=text, text_display=text, niche="wedding")
    session.add(term)
    await session.commit()
    return term


async def test_term_detail_404_for_missing_term(db_session: AsyncSession) -> None:
    response = await get("/terms/999999999")
    assert response.status_code == 404


async def test_term_detail_shows_term_without_candidate(db_session: AsyncSession) -> None:
    term = await make_term(db_session)

    response = await get(f"/terms/{term.id}")

    assert response.status_code == 200
    assert "wedding sign personalized" in response.text
    assert "chưa có candidate nào" in response.text


async def test_term_detail_shows_generate_brief_form_for_non_blocked_candidate(
    db_session: AsyncSession,
) -> None:
    term = await make_term(db_session)
    db_session.add(Candidate(term_id=term.id, risk_level="low"))
    await db_session.commit()

    response = await get(f"/terms/{term.id}")

    assert "Sinh design brief" in response.text


async def test_term_detail_hides_brief_form_for_blocked_candidate(
    db_session: AsyncSession,
) -> None:
    term = await make_term(db_session)
    db_session.add(Candidate(term_id=term.id, risk_level="blocked"))
    await db_session.commit()

    response = await get(f"/terms/{term.id}")

    assert "Sinh design brief" not in response.text
    assert "không sinh brief" in response.text


async def test_check_uspto_action_writes_risk_flag_and_returns_fragment(
    db_session: AsyncSession,
) -> None:
    term = await make_term(db_session, "term nowhere in uspto index")

    response = await post(f"/terms/{term.id}/check-uspto")

    assert response.status_code == 200
    assert "USPTO" in response.text
    assert "review" in response.text  # không tìm thấy + index chưa xác nhận phủ đủ -> review

    from sqlalchemy import select

    from scanner.core.models import RiskFlag

    flags = (
        await db_session.execute(select(RiskFlag).where(RiskFlag.term_id == term.id))
    ).scalars().all()
    assert len(flags) == 1
    assert flags[0].layer == "uspto"


async def test_check_llm_action_writes_risk_flag_and_returns_fragment(
    db_session: AsyncSession,
) -> None:
    term = await make_term(db_session, "some funny term")

    response = await post(f"/terms/{term.id}/check-llm")

    assert response.status_code == 200
    assert "LLM origin" in response.text
    assert "review" in response.text  # không có ANTHROPIC_API_KEY -> review

    from sqlalchemy import select

    from scanner.core.models import RiskFlag

    flags = (
        await db_session.execute(select(RiskFlag).where(RiskFlag.term_id == term.id))
    ).scalars().all()
    assert len(flags) == 1
    assert flags[0].layer == "llm_origin"


async def test_check_uspto_action_404_for_missing_term(db_session: AsyncSession) -> None:
    response = await post("/terms/999999999/check-uspto")
    assert response.status_code == 404
