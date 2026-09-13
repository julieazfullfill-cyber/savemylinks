"""Test offline cho pinterest_trends — fixture bắt từ response thật của endpoint
public `https://trends.pinterest.com/metrics/`, xem docstring adapters/pinterest_trends.py.
"""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import httpx
import pytest

from scanner.adapters.base import RawItem
from scanner.adapters.pinterest_trends import (
    PinterestTrendsAdapter,
    _history_point,
    _latest_friday_on_or_before,
)


def make_raw(payload: dict[str, Any]) -> RawItem:
    return RawItem(
        external_id="x",
        payload=payload,
        fetched_at=datetime(2026, 9, 13, 2, 0, tzinfo=UTC),
        seed="bridesmaid proposal box",
    )


def test_adapter_is_per_seed_and_trends_kind() -> None:
    # Endpoint /metrics/ là public REST đơn giản, nhận seed trực tiếp — khác hẳn
    # phương án country-snapshot ban đầu, không cần per_seed=False.
    assert PinterestTrendsAdapter.per_seed is True
    assert PinterestTrendsAdapter.kind == "trends"


def test_extract_emits_one_observation_per_real_history_week(
    pinterest_trends_payload: dict[str, Any],
) -> None:
    observations = PinterestTrendsAdapter().extract(make_raw(pinterest_trends_payload))

    # Fixture thật có 53 tuần, tất cả là lịch sử thật (predicted_days=0 trong query).
    assert len(observations) == 53
    assert all(o.text == "bridesmaid proposal box" for o in observations)
    dates = {o.observed_at.date() for o in observations}
    assert date(2025, 9, 5) in dates
    assert date(2026, 9, 4) in dates
    assert all(o.rank is None for o in observations)  # nguồn value-based, không có rank


def test_extract_sets_value_from_count(pinterest_trends_payload: dict[str, Any]) -> None:
    observations = PinterestTrendsAdapter().extract(make_raw(pinterest_trends_payload))
    first_week = next(o for o in observations if o.observed_at.date() == date(2025, 9, 5))
    assert first_week.value == Decimal("97")


def test_extract_skips_terms_missing_from_response() -> None:
    # Seed gửi lên nhưng Pinterest không trả (quá ít volume) — không phải lỗi.
    payload = {"items": []}
    assert PinterestTrendsAdapter().extract(make_raw(payload)) == []


def test_extract_excludes_predicted_future_points() -> None:
    payload = {
        "items": [
            {
                "term": "wedding sign",
                "counts": [
                    {
                        "date": "2026-08-21",
                        "count": 50,
                        "predictedUpperBoundNormalizedCount": None,
                        "predictedLowerBoundNormalizedCount": None,
                    },
                    {
                        "date": "2026-09-25",
                        "count": 80,
                        "predictedUpperBoundNormalizedCount": 86,
                        "predictedLowerBoundNormalizedCount": 57,
                    },
                ],
            }
        ]
    }
    observations = PinterestTrendsAdapter().extract(make_raw(payload))
    assert len(observations) == 1
    assert observations[0].observed_at.date() == date(2026, 8, 21)


def test_extract_on_broken_payload_returns_empty() -> None:
    assert PinterestTrendsAdapter().extract(make_raw({})) == []
    assert PinterestTrendsAdapter().extract(make_raw({"items": "not a list"})) == []


def test_history_point_rejects_missing_or_malformed_date() -> None:
    assert _history_point({"count": 5}) == (None, None)
    assert _history_point({"count": 5, "date": "not-a-date"}) == (None, None)
    assert _history_point("not a dict") == (None, None)
    assert _history_point({"date": "2026-08-21", "count": "not-a-number"}) == (None, None)


async def test_fetch_sends_expected_params_no_auth_needed(
    pinterest_trends_payload: dict[str, Any],
) -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        seen["cookie"] = request.headers.get("cookie")
        return httpx.Response(200, json=pinterest_trends_payload["items"])

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = PinterestTrendsAdapter(client=client)
    raws = await adapter.fetch("bridesmaid proposal box")
    await client.aclose()

    assert len(raws) == 1
    assert seen["params"]["terms"] == "bridesmaid proposal box"
    assert seen["params"]["days"] == "365"
    assert seen["params"]["predicted_days"] == "0"
    assert seen["cookie"] is None  # public, không cần cookie/CSRF


async def test_fetch_raises_on_non_array_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "object"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = PinterestTrendsAdapter(client=client)
    with pytest.raises(ValueError, match="không phải JSON array"):
        await adapter.fetch("wedding sign")
    await client.aclose()


def test_latest_friday_on_or_before() -> None:
    assert _latest_friday_on_or_before(date(2026, 9, 13)) == date(2026, 9, 11)  # Chủ Nhật
    assert _latest_friday_on_or_before(date(2026, 9, 11)) == date(2026, 9, 11)  # đã là Thứ Sáu
    assert _latest_friday_on_or_before(date(2026, 9, 7)) == date(2026, 9, 4)  # Thứ Hai


async def test_fetch_steps_back_a_week_when_latest_friday_not_ready(
    pinterest_trends_payload: dict[str, Any],
) -> None:
    # Pinterest có độ trễ publish thật: Thứ Sáu gần nhất có thể chưa sẵn sàng (400),
    # tuần trước đó thì có (200) — xác nhận trực tiếp bằng curl thật, không đoán.
    seen_end_dates: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        end_date = dict(request.url.params)["end_date"]
        seen_end_dates.append(end_date)
        if len(seen_end_dates) == 1:
            return httpx.Response(400, json=[])
        return httpx.Response(200, json=pinterest_trends_payload["items"])

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = PinterestTrendsAdapter(client=client)
    raws = await adapter.fetch("bridesmaid proposal box")
    await client.aclose()

    assert len(raws) == 1
    assert len(seen_end_dates) == 2
    first, second = (date.fromisoformat(d) for d in seen_end_dates)
    assert (first - second).days == 7


async def test_fetch_gives_up_after_max_lookback_weeks() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json=[])

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = PinterestTrendsAdapter(client=client)
    with pytest.raises(httpx.HTTPStatusError):
        await adapter.fetch("bridesmaid proposal box")
    await client.aclose()


async def test_fetch_safe_swallows_errors() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("mạng chết")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = PinterestTrendsAdapter(client=client)
    assert await adapter.fetch_safe("wedding sign") == []
    await client.aclose()
