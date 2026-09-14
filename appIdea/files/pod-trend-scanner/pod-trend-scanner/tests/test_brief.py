"""Test pipeline/brief.py — sinh design_brief qua LLM (mock httpx, không gọi mạng
thật) + enforce fail-closed. Cần Postgres đã migrate; không có thì skip (generate_brief
đọc term/candidate thật qua session)."""

from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.config import get_settings
from scanner.core.models import Candidate, RawItem, Seed, Source, Term, TermObservation
from scanner.pipeline.brief import (
    BriefBlockedError,
    BriefExportBlockedError,
    BriefLLMFailedError,
    export_brief,
    generate_brief,
)
from scanner.pipeline.risk import approve_candidate

pytestmark = pytest.mark.db


@pytest.fixture(autouse=True)
def reset_settings(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    get_settings.cache_clear()
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    yield
    get_settings.cache_clear()


async def make_candidate(
    session: AsyncSession, text: str, *, risk_level: str = "low", risk_tier: str = "T0"
) -> Candidate:
    seed = Seed(seed=text, niche="wedding", risk_tier=risk_tier)
    session.add(seed)
    await session.flush()
    source = Source(name="test_source_brief", kind="autocomplete", config={})
    session.add(source)
    await session.flush()
    raw = RawItem(source_id=source.id, external_id=f"raw-{text}", payload={})
    session.add(raw)
    await session.flush()
    term = Term(text_norm=text, text_key=text, text_display=text, niche="wedding")
    session.add(term)
    await session.flush()
    session.add(
        TermObservation(
            term_id=term.id,
            source_id=source.id,
            seed_id=seed.id,
            observed_at=datetime.now(UTC),
            rank=1,
            raw_item_id=raw.id,
        )
    )
    candidate = Candidate(term_id=term.id, risk_level=risk_level)
    session.add(candidate)
    await session.commit()
    return candidate


WEDDING_BRIEF_JSON = """{
  "source": {"term": "bridesmaid proposal box", "niche": "wedding", "risk_tier": "T0"},
  "product": {"type": "tshirt", "print_area": "front_center", "canvas_px": [4500, 5400],
              "print_method": "dtg", "max_colors": 4},
  "concept": {"buyer": "Co dau 27-34", "occasion": "Bridesmaid proposal",
              "emotional_angle": "sentimental", "why_it_sells": "khoanh khac dang len mang"},
  "text_layer": {"enabled": true, "headline": "WILL YOU BE MY BRIDESMAID",
                 "typography": {"primary_style": "serif", "case": "upper", "arrangement": "stacked"}},
  "art_layer": {"enabled": true, "subject": "eucalyptus sprig", "style": "fine line botanical illustration",
                "composition": "wreath around text",
                "palette": {"mode": "limited", "colors": ["#7A8B6F"], "background": "transparent"},
                "detail_level": "moderate", "texture": "clean"},
  "layout": {"text_anchor": "overlay_center", "safe_margin_pct": 8},
  "listing": {"title": "Bridesmaid Proposal Shirt", "tags": ["bridesmaid"]},
  "risk": {"level": "low", "origin_classification": "generic"}
}"""

TYPOGRAPHY_ONLY_BRIEF_JSON = """{
  "source": {"term": "nurse humor shirt", "niche": "occupation_humor", "risk_tier": "T1"},
  "product": {"type": "tshirt", "print_area": "front_center", "canvas_px": [4500, 5400],
              "print_method": "dtg", "max_colors": 2},
  "concept": {"buyer": "Dieu duong", "occasion": "Nurses Week",
              "emotional_angle": "sarcastic", "why_it_sells": "cau dua trong nghe"},
  "text_layer": {"enabled": true, "headline": "RUNS ON CAFFEINE",
                 "typography": {"primary_style": "bold sans", "case": "upper", "arrangement": "stacked"}},
  "art_layer": {"enabled": false},
  "layout": {"text_anchor": "text_only", "safe_margin_pct": 10},
  "listing": {"title": "Nurse Humor Shirt", "tags": ["nurse"]},
  "risk": {"level": "low", "origin_classification": "generic"}
}"""


def _anthropic_response(text: str) -> httpx.Response:
    return httpx.Response(200, json={"content": [{"type": "text", "text": text}]})


async def test_blocked_candidate_refuses_to_generate_no_llm_call(db_session: AsyncSession) -> None:
    candidate = await make_candidate(db_session, "star wars mug", risk_level="blocked")
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return _anthropic_response(WEDDING_BRIEF_JSON)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(BriefBlockedError):
        await generate_brief(db_session, candidate, http_client=client)
    await client.aclose()

    assert call_count["n"] == 0  # không tốn tiền LLM cho candidate đã blocked


async def test_no_api_key_marks_llm_failed(db_session: AsyncSession) -> None:
    candidate = await make_candidate(db_session, "generic wedding sign")

    with pytest.raises(BriefLLMFailedError):
        await generate_brief(db_session, candidate)

    assert candidate.status == "llm_failed"


async def test_successful_generation_creates_row_with_rendered_prompt(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    get_settings.cache_clear()
    candidate = await make_candidate(db_session, "bridesmaid proposal box")

    def handler(request: httpx.Request) -> httpx.Response:
        return _anthropic_response(WEDDING_BRIEF_JSON)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    row = await generate_brief(db_session, candidate, http_client=client)
    await client.aclose()

    assert row.candidate_id == candidate.id
    assert row.payload["source"]["term"] == "bridesmaid proposal box"
    assert row.image_prompt is not None
    assert "eucalyptus sprig" in row.image_prompt
    # constraints do renderer chèn theo product.type (DESIGN_BRIEF_SPEC.md mục 2/6).
    assert any("trong suốt" in c for c in row.payload["constraints"])


async def test_typography_only_brief_has_no_image_prompt(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    get_settings.cache_clear()
    candidate = await make_candidate(db_session, "nurse humor shirt", risk_tier="T1")

    def handler(request: httpx.Request) -> httpx.Response:
        return _anthropic_response(TYPOGRAPHY_ONLY_BRIEF_JSON)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    row = await generate_brief(db_session, candidate, http_client=client)
    await client.aclose()

    assert row.image_prompt is None


async def test_malformed_llm_output_retries_once_then_llm_failed(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    get_settings.cache_clear()
    candidate = await make_candidate(db_session, "another wedding term")
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return _anthropic_response("not json {{{")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(BriefLLMFailedError):
        await generate_brief(db_session, candidate, http_client=client)
    await client.aclose()

    assert call_count["n"] == 2  # gọi đầu + đúng 1 retry
    assert candidate.status == "llm_failed"


async def test_export_blocked_without_approval_for_t2(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    get_settings.cache_clear()
    candidate = await make_candidate(db_session, "pop culture edit shirt", risk_tier="T2")

    def handler(request: httpx.Request) -> httpx.Response:
        return _anthropic_response(WEDDING_BRIEF_JSON)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await generate_brief(db_session, candidate, http_client=client)
    await client.aclose()
    await db_session.commit()

    with pytest.raises(BriefExportBlockedError):
        await export_brief(db_session, candidate, "T2")


async def test_export_succeeds_after_approval(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    get_settings.cache_clear()
    candidate = await make_candidate(db_session, "bridesmaid box export test")

    def handler(request: httpx.Request) -> httpx.Response:
        return _anthropic_response(WEDDING_BRIEF_JSON)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await generate_brief(db_session, candidate, http_client=client)
    await client.aclose()
    await approve_candidate(db_session, candidate, "T0", approved_by=None)
    await db_session.commit()

    payload = await export_brief(db_session, candidate, "T0")

    assert payload["source"]["term"] == "bridesmaid proposal box"
    assert payload["image_prompt"] is not None


async def test_export_without_any_brief_generated_is_blocked(db_session: AsyncSession) -> None:
    candidate = await make_candidate(db_session, "no brief yet term")
    await approve_candidate(db_session, candidate, "T0", approved_by=None)
    await db_session.commit()

    with pytest.raises(BriefExportBlockedError):
        await export_brief(db_session, candidate, "T0")
