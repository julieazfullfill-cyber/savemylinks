"""Test offline cho google_suggest và bing_suggest — cùng shape response (JSON array)."""

from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from scanner.adapters.base import RawItem
from scanner.adapters.bing_suggest import BingSuggestAdapter
from scanner.adapters.google_suggest import GoogleSuggestAdapter

ADAPTERS = [GoogleSuggestAdapter, BingSuggestAdapter]


def make_raw(payload: dict[str, Any]) -> RawItem:
    return RawItem(
        external_id="x",
        payload=payload,
        fetched_at=datetime(2026, 9, 13, 2, 0, tzinfo=UTC),
        seed="bridesmaid proposal box",
    )


@pytest.mark.parametrize("adapter_cls", ADAPTERS)
def test_extract_ranks_suggestions_in_order(
    adapter_cls: type, google_payload: list[Any], bing_payload: list[Any]
) -> None:
    raw_array = google_payload if adapter_cls is GoogleSuggestAdapter else bing_payload
    wrapped = {"query": raw_array[0], "suggestions": raw_array[1], "raw": raw_array}
    observations = adapter_cls().extract(make_raw(wrapped))

    assert len(observations) == len(raw_array[1])
    assert [o.rank for o in observations] == list(range(1, len(observations) + 1))
    assert observations[0].text == raw_array[1][0]


@pytest.mark.parametrize("adapter_cls", ADAPTERS)
def test_extract_skips_blank_and_non_string_entries(adapter_cls: type) -> None:
    wrapped = {"suggestions": ["wedding sign", "   ", 123, "wedding guest book"]}
    observations = adapter_cls().extract(make_raw(wrapped))
    assert [o.text for o in observations] == ["wedding sign", "wedding guest book"]
    assert [o.rank for o in observations] == [1, 2]


@pytest.mark.parametrize("adapter_cls", ADAPTERS)
def test_extract_on_broken_payload_returns_empty(adapter_cls: type) -> None:
    assert adapter_cls().extract(make_raw({"suggestions": "not a list"})) == []


@pytest.mark.parametrize("adapter_cls", ADAPTERS)
async def test_fetch_wraps_array_response(
    adapter_cls: type, google_payload: list[Any], bing_payload: list[Any]
) -> None:
    raw_array = google_payload if adapter_cls is GoogleSuggestAdapter else bing_payload

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=raw_array)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = adapter_cls(client=client)
    raws = await adapter.fetch("bridesmaid proposal box")
    await client.aclose()

    assert len(raws) == 1
    assert raws[0].payload["suggestions"] == raw_array[1]


@pytest.mark.parametrize("adapter_cls", ADAPTERS)
async def test_fetch_raises_on_non_array_response(adapter_cls: type) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "object"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = adapter_cls(client=client)
    with pytest.raises(ValueError, match="không đúng dạng"):
        await adapter.fetch("wedding sign")
    await client.aclose()


@pytest.mark.parametrize("adapter_cls", ADAPTERS)
async def test_fetch_safe_swallows_errors(adapter_cls: type) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("mạng chết")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = adapter_cls(client=client)
    assert await adapter.fetch_safe("wedding sign") == []
    await client.aclose()
