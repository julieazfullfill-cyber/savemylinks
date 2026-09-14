"""Integration test cho /seeds (xem + thêm seed thủ công qua web). Cần Postgres đã
migrate; skip nếu không có."""

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import Seed
from scanner.web.app import app

pytestmark = pytest.mark.db


async def get(path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


async def post(path: str, data: dict[str, str]) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", follow_redirects=False
    ) as client:
        return await client.post(path, data=data)


async def test_seeds_page_empty_state(db_session: AsyncSession) -> None:
    response = await get("/seeds")
    assert response.status_code == 200
    assert "Chưa có seed nào" in response.text


async def test_add_seed_creates_row(db_session: AsyncSession) -> None:
    response = await post(
        "/seeds",
        {
            "seed": "cottagecore mug funny",
            "niche": "funny_quote",
            "risk_tier": "T1",
            "personalized": "",
            "intent": "self",
            "peak_months": "",
            "note": "",
        },
    )

    assert response.status_code == 303
    assert response.headers["location"] == "/seeds"

    row = (
        await db_session.execute(
            select(Seed).where(Seed.seed == "cottagecore mug funny", Seed.niche == "funny_quote")
        )
    ).scalar_one()
    assert row.risk_tier == "T1"
    assert row.intent == "self"


async def test_add_seed_with_peak_months_and_personalized(db_session: AsyncSession) -> None:
    response = await post(
        "/seeds",
        {
            "seed": "custom pet portrait mug",
            "niche": "custom_photo",
            "risk_tier": "T0",
            "personalized": "true",
            "peak_months": "11, 12",
            "note": "gift season",
        },
    )

    assert response.status_code == 303
    row = (
        await db_session.execute(
            select(Seed).where(
                Seed.seed == "custom pet portrait mug", Seed.niche == "custom_photo"
            )
        )
    ).scalar_one()
    assert row.personalized is True
    assert list(row.peak_months) == [11, 12]
    assert row.note == "gift season"


async def test_add_seed_rejects_invalid_risk_tier(db_session: AsyncSession) -> None:
    response = await post(
        "/seeds", {"seed": "some term", "niche": "misc", "risk_tier": "T9"}
    )

    assert response.status_code == 303
    assert response.headers["location"].startswith("/seeds?error=")
    row = (
        await db_session.execute(select(Seed).where(Seed.seed == "some term"))
    ).scalar_one_or_none()
    assert row is None


async def test_add_seed_is_idempotent_upsert(db_session: AsyncSession) -> None:
    data = {"seed": "dup seed check", "niche": "funny_quote", "risk_tier": "T1"}
    await post("/seeds", data)
    await post("/seeds", data)

    rows = (
        await db_session.execute(select(Seed).where(Seed.seed == "dup seed check"))
    ).scalars().all()
    assert len(rows) == 1


async def test_seeds_page_shows_summary_and_recent(db_session: AsyncSession) -> None:
    await post("/seeds", {"seed": "visible seed term", "niche": "funny_quote", "risk_tier": "T1"})

    response = await get("/seeds")

    assert "visible seed term" in response.text
    assert "funny_quote" in response.text
