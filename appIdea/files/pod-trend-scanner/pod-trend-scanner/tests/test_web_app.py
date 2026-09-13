"""Integration test cho trang dashboard tối thiểu. Cần Postgres đã migrate; skip nếu không có.

Dùng httpx.AsyncClient + ASGITransport (không phải starlette TestClient đồng bộ) vì
test chạy trong event loop async sẵn có của pytest-asyncio — TestClient tự mở loop
riêng sẽ xung đột.
"""

from datetime import date
from decimal import Decimal

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import Term, TermMetricsDaily
from scanner.web.app import app

pytestmark = pytest.mark.db

TODAY = date(2026, 8, 15)


async def get(path: str = "/") -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


async def test_top_terms_page_handles_empty_metrics(db_session: AsyncSession) -> None:
    response = await get()
    assert response.status_code == 200
    assert "Chưa có dữ liệu" in response.text


async def test_top_terms_page_lists_terms_sorted_by_accel(db_session: AsyncSession) -> None:
    hot = Term(text_norm="hot term", text_key="hot term", text_display="Hot Term", niche="wedding")
    cold = Term(
        text_norm="cold term", text_key="cold term", text_display="Cold Term", niche="wedding"
    )
    db_session.add_all([hot, cold])
    await db_session.flush()
    db_session.add_all(
        [
            TermMetricsDaily(
                term_id=hot.id,
                date=TODAY,
                value_norm=Decimal("80"),
                velocity_7d=Decimal("10"),
                velocity_21d=Decimal("2"),
                accel=Decimal("8"),
                n_sources=2,
            ),
            TermMetricsDaily(
                term_id=cold.id,
                date=TODAY,
                value_norm=Decimal("20"),
                velocity_7d=Decimal("-1"),
                velocity_21d=Decimal("1"),
                accel=Decimal("-2"),
                n_sources=1,
            ),
        ]
    )
    await db_session.commit()

    response = await get()

    assert response.status_code == 200
    body = response.text
    assert "Hot Term" in body and "Cold Term" in body
    assert body.index("Hot Term") < body.index("Cold Term")  # accel cao hơn xếp trước


async def test_top_terms_page_respects_limit_query_param(db_session: AsyncSession) -> None:
    for i in range(5):
        term = Term(
            text_norm=f"term {i}", text_key=f"term {i}", text_display=f"Term {i}", niche="wedding"
        )
        db_session.add(term)
        await db_session.flush()
        db_session.add(
            TermMetricsDaily(
                term_id=term.id, date=TODAY, value_norm=Decimal(str(i)), accel=Decimal(str(i))
            )
        )
    await db_session.commit()

    response = await get("/?limit=2")

    assert response.status_code == 200
    assert "2 term (giới hạn 2)" in response.text


async def test_top_terms_page_puts_null_accel_last(db_session: AsyncSession) -> None:
    scored = Term(
        text_norm="scored", text_key="scored", text_display="Scored", niche="wedding"
    )
    unscored = Term(
        text_norm="unscored", text_key="unscored", text_display="Unscored", niche="wedding"
    )
    db_session.add_all([scored, unscored])
    await db_session.flush()
    db_session.add_all(
        [
            TermMetricsDaily(term_id=scored.id, date=TODAY, value_norm=Decimal("10"), accel=Decimal("-5")),
            TermMetricsDaily(term_id=unscored.id, date=TODAY, value_norm=Decimal("50"), accel=None),
        ]
    )
    await db_session.commit()

    response = await get()

    body = response.text
    assert body.index("Scored") < body.index("Unscored")
