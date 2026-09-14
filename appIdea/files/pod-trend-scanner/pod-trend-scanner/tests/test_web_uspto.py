"""Integration test cho /uspto (trang nạp bulk data + tiến độ). Cần Postgres đã
migrate; skip nếu không có. Nạp file fixture thật (không phải dữ liệu tự dựng) qua
HTTP — BackgroundTasks của Starlette chạy TRONG cùng call ASGI nên khi
`client.post(...)` trả về, lượt nạp nền đã chạy xong (không cần poll thật trong test)."""

from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.web import app as app_module
from scanner.web.app import UsptoLoadState, app

pytestmark = pytest.mark.db

FIXTURE = Path(__file__).parent / "fixtures" / "uspto_bulk_sample.xml"


@pytest.fixture(autouse=True)
def reset_load_state():  # type: ignore[no-untyped-def]
    app_module._uspto_load_state = UsptoLoadState()
    yield
    app_module._uspto_load_state = UsptoLoadState()


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


async def test_uspto_page_loads_empty_state(db_session: AsyncSession) -> None:
    response = await get("/uspto")
    assert response.status_code == 200
    assert "USPTO_INDEX_COVERAGE_COMPLETE" in response.text
    assert "0" in response.text  # 0 file/record khi index rỗng


async def test_load_action_runs_in_background_and_indexes_real_fixture(
    db_session: AsyncSession,
) -> None:
    response = await post("/uspto/load", {"path": str(FIXTURE)})

    assert response.status_code == 303
    assert response.headers["location"] == "/uspto"
    # BackgroundTasks đã chạy xong trong cùng call -- status-fragment phản ánh ngay.
    status_response = await get("/uspto/status-fragment")
    assert "1" in status_response.text  # 1 file đã nạp
    assert "3" in status_response.text  # 3 record (fixture có 3 case-file thật)


async def test_load_action_rejects_concurrent_run(db_session: AsyncSession) -> None:
    app_module._uspto_load_state = UsptoLoadState(running=True, current_file="busy.xml")

    response = await post("/uspto/load", {"path": str(FIXTURE)})

    assert response.status_code == 303
    assert response.headers["location"].startswith("/uspto?error=")
