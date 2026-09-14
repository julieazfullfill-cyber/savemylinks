"""Test Lớp 3 (LLM phân loại nguồn gốc) — offline, không gọi Anthropic API thật.

Không có ANTHROPIC_API_KEY trong phiên build này nên không verify được response thật
từ model — test ở đây verify hành vi fail-closed (rule 10: retry đúng 1 lần, fail lần
hai -> review) bằng cách mock httpx, độc lập với việc model trả lời gì thật.
"""

from typing import Any

import httpx
import pytest

from scanner.core.config import get_settings
from scanner.pipeline.risk import classify_origin


async def test_no_api_key_falls_back_to_review(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    result = await classify_origin("some term")
    get_settings.cache_clear()

    assert result.verdict == "review"
    assert "ANTHROPIC_API_KEY" in result.evidence["reason"]


def _anthropic_response(text: str) -> httpx.Response:
    return httpx.Response(200, json={"content": [{"type": "text", "text": text}]})


async def test_generic_origin_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")

    def handler(request: httpx.Request) -> httpx.Response:
        return _anthropic_response('{"origin": "generic", "reasoning": "ngôn ngữ chung"}')

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await classify_origin("bridesmaid proposal box", client)
    await client.aclose()
    get_settings.cache_clear()

    assert result.verdict == "pass"
    assert result.evidence["origin"] == "generic"


@pytest.mark.parametrize("origin", ["derived_from_media", "proper_noun", "unknown"])
async def test_non_generic_origins_go_to_review(
    monkeypatch: pytest.MonkeyPatch, origin: str
) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")

    def handler(request: httpx.Request) -> httpx.Response:
        return _anthropic_response(f'{{"origin": "{origin}", "reasoning": "..."}}')

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await classify_origin("some term", client)
    await client.aclose()
    get_settings.cache_clear()

    assert result.verdict == "review"


async def test_malformed_json_retries_once_then_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return _anthropic_response("không phải JSON hợp lệ {{{")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await classify_origin("some term", client)
    await client.aclose()
    get_settings.cache_clear()

    assert result.verdict == "review"
    assert call_count["n"] == 2  # gọi lần đầu + đúng 1 lần retry, không hơn


async def test_invalid_origin_enum_value_retries_then_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        # "origin" không nằm trong 4 giá trị hợp lệ -> Pydantic ValidationError.
        return _anthropic_response('{"origin": "not_a_real_value", "reasoning": "x"}')

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await classify_origin("some term", client)
    await client.aclose()
    get_settings.cache_clear()

    assert result.verdict == "review"
    assert call_count["n"] == 2


async def test_recovers_on_second_attempt_after_first_malformed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _anthropic_response("broken")
        return _anthropic_response('{"origin": "generic", "reasoning": "ok lần 2"}')

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await classify_origin("some term", client)
    await client.aclose()
    get_settings.cache_clear()

    assert result.verdict == "pass"
    assert call_count["n"] == 2


async def test_http_error_falls_back_to_review(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(529, text="overloaded")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await classify_origin("some term", client)
    await client.aclose()
    get_settings.cache_clear()

    assert result.verdict == "review"
