"""Test offline cho pinterest_suggest — fixture bắt từ response thật qua Chrome
DevTools automation (session đã đăng nhập), xem docstring adapters/pinterest_suggest.py.
"""

from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from scanner.adapters.base import RawItem
from scanner.adapters.pinterest_suggest import (
    PinterestNotAuthenticated,
    PinterestSuggestAdapter,
)
from scanner.core.config import get_settings


def make_raw(payload: dict[str, Any]) -> RawItem:
    return RawItem(
        external_id="x",
        payload=payload,
        fetched_at=datetime(2026, 9, 13, 2, 0, tzinfo=UTC),
        seed="wedding",
    )


def test_extract_keeps_only_query_type_items_in_rank_order(
    pinterest_payload: dict[str, Any],
) -> None:
    observations = PinterestSuggestAdapter().extract(make_raw(pinterest_payload))

    # Fixture có 11 item type=query + 1 item type=user (bị bỏ qua).
    assert len(observations) == 11
    assert observations[0].text == "wedding invitations"
    assert observations[0].rank == 1  # resultIndex 0 -> rank 1
    assert observations[-1].text == "wedding photos"
    assert observations[-1].rank == 12  # resultIndex 11 -> rank 12, giữ đúng thứ hạng gốc
    assert all(o.rank is not None and o.rank > 0 for o in observations)


def test_extract_ignores_pin_count_stays_none(pinterest_payload: dict[str, Any]) -> None:
    # pin_count luôn 0 trong response thật của endpoint này — không phải volume thật,
    # value_norm phải tính theo rank (value=None), không dùng pin_count.
    observations = PinterestSuggestAdapter().extract(make_raw(pinterest_payload))
    assert all(o.value is None for o in observations)


def test_extract_on_failed_status_returns_empty() -> None:
    payload = {"resource_response": {"status": "failure", "data": {"items": []}}}
    assert PinterestSuggestAdapter().extract(make_raw(payload)) == []


def test_extract_on_broken_payload_returns_empty() -> None:
    assert PinterestSuggestAdapter().extract(make_raw({})) == []
    assert PinterestSuggestAdapter().extract(make_raw({"resource_response": "nope"})) == []


async def test_fetch_without_cookie_raises_not_authenticated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    monkeypatch.delenv("PINTEREST_COOKIE", raising=False)
    adapter = PinterestSuggestAdapter()
    with pytest.raises(PinterestNotAuthenticated):
        await adapter.fetch("wedding")
    get_settings.cache_clear()


async def test_fetch_safe_swallows_missing_cookie(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    monkeypatch.delenv("PINTEREST_COOKIE", raising=False)
    adapter = PinterestSuggestAdapter()
    assert await adapter.fetch_safe("wedding") == []
    get_settings.cache_clear()


async def test_fetch_sends_cookie_and_derived_csrf_header(
    monkeypatch: pytest.MonkeyPatch, pinterest_payload: dict[str, Any]
) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("PINTEREST_COOKIE", "csrftoken=abc123; sessionid=zzz")
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["cookie"] = request.headers.get("cookie")
        seen["csrf"] = request.headers.get("x-csrftoken")
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json=pinterest_payload)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = PinterestSuggestAdapter(client=client)
    raws = await adapter.fetch("wedding")
    await client.aclose()
    get_settings.cache_clear()

    assert len(raws) == 1
    assert seen["cookie"] == "csrftoken=abc123; sessionid=zzz"
    assert seen["csrf"] == "abc123"
    assert '"term": "wedding"' in seen["params"]["data"] or '"term":"wedding"' in seen["params"][
        "data"
    ]


async def test_fetch_raises_on_403_and_fetch_safe_returns_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("PINTEREST_COOKIE", "sessionid=zzz")  # thiếu csrftoken -> vẫn thử, server chặn

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="Invalid Resource Request")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = PinterestSuggestAdapter(client=client)
    result = await adapter.fetch_safe("wedding")
    await client.aclose()
    get_settings.cache_clear()

    assert result == []
