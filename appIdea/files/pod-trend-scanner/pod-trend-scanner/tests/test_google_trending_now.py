"""Test offline cho google_trending_now — fixture trích THẬT (rút gọn) từ response
thật của `https://trends.google.com/trending?geo=US`, xem docstring
adapters/google_trending_now.py. Không gọi mạng thật (CLAUDE.md rule 18)."""

from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from scanner.adapters.base import RawItem
from scanner.adapters.google_trending_now import (
    GoogleTrendingNowAdapter,
    _entry_to_observation,
    _parse_trending_entries,
)

FIXTURE_HTML = (
    Path(__file__).parent / "fixtures" / "google_trending_now_sample.html"
).read_text(encoding="utf-8")


def test_adapter_is_per_seed_false_and_trending_kind() -> None:
    # per_seed=False -- xem docstring adapters/base.py: pipeline gọi fetch() đúng 1
    # lần/lượt collect, không lặp qua seed (dữ liệu không phụ thuộc seed nào).
    assert GoogleTrendingNowAdapter.per_seed is False
    assert GoogleTrendingNowAdapter.kind == "trending"


def test_parse_trending_entries_extracts_real_fixture_structure() -> None:
    entries = _parse_trending_entries(FIXTURE_HTML)

    assert len(entries) == 5
    assert entries[0][0] == "cowboys"  # rank 1, chủ đề hot nhất lúc bắt fixture


def test_parse_trending_entries_returns_empty_on_missing_block() -> None:
    assert _parse_trending_entries("<html><body>không có gì</body></html>") == []


def test_parse_trending_entries_returns_empty_on_malformed_json() -> None:
    broken = "AF_initDataCallback({key: 'ds:0', hash:'1', data:[not valid json, sideChannel: {}});"
    assert _parse_trending_entries(broken) == []


def test_entry_to_observation_maps_real_fields() -> None:
    entries = _parse_trending_entries(FIXTURE_HTML)
    now = datetime(2026, 9, 14, 8, 0, tzinfo=UTC)

    obs = _entry_to_observation(entries[0], rank=1, observed_at=now)

    assert obs is not None
    assert obs.text == "cowboys"
    assert obs.rank == 1
    assert obs.value == 2000000
    assert "related" in obs.meta
    assert "cowboys" in obs.meta["related"]


def test_entry_to_observation_none_for_malformed_entry() -> None:
    assert _entry_to_observation("not a list", rank=1, observed_at=datetime.now(UTC)) is None
    assert _entry_to_observation([None, None], rank=1, observed_at=datetime.now(UTC)) is None
    assert _entry_to_observation([123, None, "US"], rank=1, observed_at=datetime.now(UTC)) is None


async def test_fetch_sends_geo_param_no_auth_needed() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        seen["cookie"] = request.headers.get("cookie")
        return httpx.Response(200, text=FIXTURE_HTML)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = GoogleTrendingNowAdapter(client=client)
    raws = await adapter.fetch("")
    await client.aclose()

    assert len(raws) == 1
    assert seen["params"] == {"geo": "US"}
    assert seen["cookie"] is None  # public, không cần cookie/CSRF
    assert len(raws[0].payload["entries"]) == 5


async def test_fetch_raises_when_ds0_block_missing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>trang đổi cấu trúc, không còn ds:0</html>")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = GoogleTrendingNowAdapter(client=client)
    with pytest.raises(ValueError, match="ds:0"):
        await adapter.fetch("")
    await client.aclose()


async def test_fetch_safe_swallows_errors_returns_empty() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="server error")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = GoogleTrendingNowAdapter(client=client)
    raws = await adapter.fetch_safe("")
    await client.aclose()

    assert raws == []  # rule 8: nguồn chết -> list rỗng, không raise ra ngoài


def test_extract_respects_max_terms_per_run_config() -> None:
    raw = RawItem(
        external_id="x",
        payload={"entries": _parse_trending_entries(FIXTURE_HTML)},
        fetched_at=datetime.now(UTC),
        seed=None,
    )
    adapter = GoogleTrendingNowAdapter(config={"max_terms_per_run": 2})

    observations = adapter.extract(raw)

    assert len(observations) == 2
    assert [o.rank for o in observations] == [1, 2]


def test_extract_handles_non_list_payload_gracefully() -> None:
    raw = RawItem(
        external_id="x", payload={"entries": "not a list"}, fetched_at=datetime.now(UTC), seed=None
    )
    adapter = GoogleTrendingNowAdapter()
    assert adapter.extract(raw) == []
