"""Fixture dùng chung. Không test nào được gọi network thật."""

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

FIXTURES = Path(__file__).parent / "fixtures"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
TABLES = (
    "term_observations",
    "raw_items",
    "terms",
    "seeds",
    "sources",
)


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def seed_file() -> Path:
    return PROJECT_ROOT / "data" / "seed_keywords.json"


@pytest.fixture
def amazon_payload() -> dict[str, Any]:
    payload: dict[str, Any] = load_fixture("amazon_suggest.json")
    return payload


@pytest.fixture
def google_payload() -> list[Any]:
    payload: list[Any] = load_fixture("google_suggest.json")
    return payload


@pytest.fixture
def bing_payload() -> list[Any]:
    payload: list[Any] = load_fixture("bing_suggest.json")
    return payload


@pytest_asyncio.fixture
async def db_session() -> AsyncIterator[AsyncSession]:
    """Session Postgres thật. Bỏ qua test nếu không có DB hoặc chưa migrate."""
    from scanner.core.config import get_settings

    engine = create_async_engine(get_settings().database_url)
    try:
        async with engine.connect() as conn:
            missing = await conn.scalar(text("SELECT to_regclass('public.sources')"))
        if missing is None:
            pytest.skip("chưa chạy 'alembic upgrade head' trên database này")
    except Exception as exc:  # noqa: BLE001
        await engine.dispose()
        pytest.skip(f"không kết nối được Postgres: {exc}")

    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as session:
        for table in TABLES:
            await session.execute(text(f"TRUNCATE {table} RESTART IDENTITY CASCADE"))
        await session.commit()
        yield session
        await session.rollback()

    # Engine của app được cache bằng lru_cache, mà mỗi test lại chạy trên event loop mới.
    # Không dispose thì test sau dùng lại connection thuộc loop đã đóng.
    from scanner.core import db as scanner_db

    if scanner_db.get_engine.cache_info().currsize:
        await scanner_db.dispose_engine()
        scanner_db.get_engine.cache_clear()
        scanner_db.get_sessionmaker.cache_clear()
    await engine.dispose()
