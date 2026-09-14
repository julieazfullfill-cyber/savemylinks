"""Integration test cho /review (Lớp 4, chỉ đọc). Cần Postgres đã migrate; skip nếu
không có. httpx.AsyncClient + ASGITransport — xem ghi chú tests/test_web_app.py.
"""

from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import Candidate, RiskFlag, Term
from scanner.web.app import app

pytestmark = pytest.mark.db


async def get(path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


async def test_review_page_lists_pending_review_and_blocked_candidates(
    db_session: AsyncSession,
) -> None:
    review_term = Term(
        text_norm="needs review term",
        text_key="needs review term",
        text_display="Needs Review Term",
    )
    blocked_term = Term(
        text_norm="star wars mug", text_key="mug star wars", text_display="Star Wars Mug"
    )
    approved_term = Term(
        text_norm="already approved term",
        text_key="already approved term",
        text_display="Already Approved Term",
    )
    db_session.add_all([review_term, blocked_term, approved_term])
    await db_session.flush()

    db_session.add_all(
        [
            Candidate(
                term_id=review_term.id,
                momentum=Decimal("0.5"),
                risk_level="review",
                status="pending",
            ),
            Candidate(term_id=blocked_term.id, risk_level="blocked", status="pending"),
            Candidate(term_id=approved_term.id, risk_level="low", status="approved"),
        ]
    )
    db_session.add(
        RiskFlag(
            term_id=blocked_term.id,
            layer="blocklist",
            severity="block",
            evidence={"matches": [{"category": "franchises", "matched": "star wars"}]},
        )
    )
    await db_session.commit()

    response = await get("/review")

    assert response.status_code == 200
    body = response.text
    assert "Needs Review Term" in body
    assert "Star Wars Mug" in body
    assert "Already Approved Term" not in body  # đã approved, không còn trong hàng đợi


async def test_review_page_empty_state(db_session: AsyncSession) -> None:
    response = await get("/review")
    assert response.status_code == 200
    assert "Không có candidate nào đang chờ duyệt" in response.text


async def test_review_page_shows_risk_flag_evidence(db_session: AsyncSession) -> None:
    term = Term(
        text_norm="flagged term", text_key="flagged term", text_display="Flagged Term"
    )
    db_session.add(term)
    await db_session.flush()
    db_session.add(Candidate(term_id=term.id, risk_level="review", status="pending"))
    db_session.add(
        RiskFlag(
            term_id=term.id,
            layer="llm_origin",
            severity="review",
            evidence={"origin": "unknown", "reasoning": "không chắc chắn"},
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    response = await get("/review")

    body = response.text
    assert "llm_origin" in body
    assert "unknown" in body
