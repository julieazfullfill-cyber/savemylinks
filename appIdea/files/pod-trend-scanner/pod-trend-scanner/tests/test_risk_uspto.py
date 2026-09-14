"""Test Lớp 2 (USPTO) — offline, không gọi mạng thật.

**Endpoint chưa xác minh bằng request thật** (WAF chặn discovery — xem docstring
pipeline/risk.py) — fixture ở đây là dữ liệu TỰ DỰNG theo cấu trúc hợp lý (status
LIVE/DEAD + classes), không phải response thật. Acceptance bắt buộc mà test này verify
KHÔNG phụ thuộc vào cấu trúc response chính xác: "USPTO API down -> review, không bao
giờ pass" — đúng dù endpoint có đổi thế nào, vì fail-closed nằm ở tầng try/except, không
phụ thuộc parse đúng hay sai.
"""

from typing import Any

import httpx
import pytest

from scanner.core.config import get_settings
from scanner.pipeline.risk import check_uspto, parse_uspto_response


def test_parse_live_trademark_in_relevant_class_blocks() -> None:
    data: list[dict[str, Any]] = [{"status": "LIVE", "classes": ["025"]}]
    result = parse_uspto_response(data)
    assert result.verdict == "block"


def test_parse_dead_trademark_passes_but_logs() -> None:
    data: list[dict[str, Any]] = [{"status": "DEAD", "classes": ["025"]}]
    result = parse_uspto_response(data)
    assert result.verdict == "pass"
    assert result.evidence["status"] == "DEAD"


def test_parse_no_matching_class_passes() -> None:
    # Đăng ký thật nhưng ở lớp không liên quan (ví dụ lớp 9 - điện tử) thì không chặn.
    data: list[dict[str, Any]] = [{"status": "LIVE", "classes": ["009"]}]
    result = parse_uspto_response(data)
    assert result.verdict == "pass"


def test_parse_empty_results_passes() -> None:
    assert parse_uspto_response([]).verdict == "pass"


def test_parse_malformed_response_is_review_not_pass() -> None:
    # response không đúng dạng list -> review, KHÔNG được coi là "không có kết quả -> pass".
    assert parse_uspto_response({"unexpected": "shape"}).verdict == "review"
    assert parse_uspto_response(None).verdict == "review"


async def test_no_api_key_configured_falls_back_to_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    monkeypatch.delenv("USPTO_API_KEY", raising=False)

    class FakeSession:
        async def scalar(self, *a: Any, **k: Any) -> None:
            return None

        async def execute(self, *a: Any, **k: Any) -> Any:
            class R:
                def scalar_one_or_none(self) -> None:
                    return None

            return R()

    result = await check_uspto(FakeSession(), term_id=1, term_text="some term")  # type: ignore[arg-type]
    get_settings.cache_clear()

    assert result.verdict == "review"
    assert "USPTO_API_KEY" in result.evidence["reason"]


async def test_api_error_500_falls_back_to_review_not_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Acceptance: "USPTO API trả 500 -> term rơi vào review, khẳng định không có
    # đường nào ra pass".
    get_settings.cache_clear()
    monkeypatch.setenv("USPTO_API_KEY", "fake-key-for-test")

    class FakeSession:
        async def scalar(self, *a: Any, **k: Any) -> None:
            return None

        async def execute(self, *a: Any, **k: Any) -> Any:
            class R:
                def scalar_one_or_none(self) -> None:
                    return None

            return R()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="internal server error")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await check_uspto(FakeSession(), term_id=1, term_text="some term", client=client)  # type: ignore[arg-type]
    await client.aclose()
    get_settings.cache_clear()

    assert result.verdict == "review"


async def test_timeout_falls_back_to_review_not_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("USPTO_API_KEY", "fake-key-for-test")

    class FakeSession:
        async def scalar(self, *a: Any, **k: Any) -> None:
            return None

        async def execute(self, *a: Any, **k: Any) -> Any:
            class R:
                def scalar_one_or_none(self) -> None:
                    return None

            return R()

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await check_uspto(FakeSession(), term_id=1, term_text="some term", client=client)  # type: ignore[arg-type]
    await client.aclose()
    get_settings.cache_clear()

    assert result.verdict == "review"


async def test_malformed_json_response_falls_back_to_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("USPTO_API_KEY", "fake-key-for-test")

    class FakeSession:
        async def scalar(self, *a: Any, **k: Any) -> None:
            return None

        async def execute(self, *a: Any, **k: Any) -> Any:
            class R:
                def scalar_one_or_none(self) -> None:
                    return None

            return R()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json at all {{{")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await check_uspto(FakeSession(), term_id=1, term_text="some term", client=client)  # type: ignore[arg-type]
    await client.aclose()
    get_settings.cache_clear()

    assert result.verdict == "review"
