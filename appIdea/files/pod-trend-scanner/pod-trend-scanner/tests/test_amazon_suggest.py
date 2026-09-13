"""Adapter test chạy hoàn toàn offline: fixture + httpx.MockTransport."""

from datetime import UTC, date, datetime
from typing import Any

import httpx
import pytest

from scanner.adapters.amazon_suggest import AmazonSuggestAdapter
from scanner.adapters.base import RawItem, daily_external_id


def make_raw(payload: dict[str, Any]) -> RawItem:
    return RawItem(
        external_id="x",
        payload=payload,
        fetched_at=datetime(2026, 9, 13, 2, 0, tzinfo=UTC),
        seed="bridesmaid proposal box",
    )


def test_extract_ranks_suggestions_in_order(amazon_payload: dict[str, Any]) -> None:
    adapter = AmazonSuggestAdapter()
    observations = adapter.extract(make_raw(amazon_payload))

    assert len(observations) == len(amazon_payload["suggestions"])
    assert [o.rank for o in observations] == list(range(1, len(observations) + 1))
    assert observations[0].text == "bridesmaid proposal box"
    assert all(o.observed_at.tzinfo is UTC for o in observations)


def test_extract_skips_ghost_and_non_keyword_rows() -> None:
    payload = {
        "suggestions": [
            {"value": "wedding sign", "type": "KEYWORD"},
            {"value": "ghost row", "type": "KEYWORD", "ghost": True},
            {"value": "Home & Kitchen", "type": "BROWSE"},
            {"value": "   ", "type": "KEYWORD"},
            {"value": "wedding guest book", "type": "KEYWORD"},
        ]
    }
    observations = AmazonSuggestAdapter().extract(make_raw(payload))
    assert [o.text for o in observations] == ["wedding sign", "wedding guest book"]
    assert [o.rank for o in observations] == [1, 2]


def test_extract_on_broken_payload_returns_empty() -> None:
    assert AmazonSuggestAdapter().extract(make_raw({"suggestions": "not a list"})) == []


async def test_fetch_sends_browser_headers_and_expected_params(
    amazon_payload: dict[str, Any],
) -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["params"] = dict(request.url.params)
        seen["ua"] = request.headers.get("user-agent", "")
        return httpx.Response(200, json=amazon_payload)

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), headers={"User-Agent": "Mozilla/5.0 test"}
    )
    adapter = AmazonSuggestAdapter(client=client)
    raws = await adapter.fetch("bridesmaid proposal box")
    await client.aclose()

    assert len(raws) == 1
    assert seen["params"]["prefix"] == "bridesmaid proposal box"
    assert seen["params"]["mid"] == "ATVPDKIKX0DER"
    assert seen["params"]["alias"] == "aps"
    assert "Mozilla" in seen["ua"]
    assert raws[0].payload == amazon_payload


async def test_fetch_retries_then_succeeds_on_429(amazon_payload: dict[str, Any]) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, json={"error": "slow down"})
        return httpx.Response(200, json=amazon_payload)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = AmazonSuggestAdapter(client=client)
    raws = await adapter.fetch("wedding sign")
    await client.aclose()

    assert calls["n"] == 2
    assert len(raws) == 1


async def test_fetch_safe_swallows_errors() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("mạng chết")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = AmazonSuggestAdapter(client=client)
    assert await adapter.fetch_safe("wedding sign") == []
    await client.aclose()

    with pytest.raises(httpx.ConnectError):
        client2 = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            await AmazonSuggestAdapter(client=client2).fetch("wedding sign")
        finally:
            await client2.aclose()


def test_external_id_is_stable_within_a_day_and_changes_next_day() -> None:
    args = ("amazon_suggest", "https://completion.amazon.com/api/2017/suggestions")
    today = date(2026, 9, 13)
    a = daily_external_id(*args, "Bridesmaid Proposal Box!", today)
    b = daily_external_id(*args, "bridesmaid proposal box", today)
    c = daily_external_id(*args, "bridesmaid proposal box", date(2026, 9, 14))
    assert a == b
    assert a != c
