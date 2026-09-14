"""Integration test cho pipeline/risk.py orchestration. Cần Postgres đã migrate;
không có thì skip. Không gọi mạng thật (không cấu hình ANTHROPIC_API_KEY, và local
USPTO index rỗng/chưa xác nhận phủ đủ trong test này — verify đúng nhánh fail-closed
thật sự sẽ chạy trong production khi thiếu dữ liệu).
"""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.config import get_settings
from scanner.core.models import Candidate, RawItem, Seed, Source, Term, TermObservation
from scanner.pipeline.risk import (
    ApprovalRequiredError,
    approve_candidate,
    determine_risk_tier,
    is_eligible_for_export,
    load_blocklist,
    run_risk_gate,
    run_risk_gate_for_candidate,
)

pytestmark = pytest.mark.db

BLOCKLIST_FILE = Path(__file__).resolve().parents[1] / "data" / "blocklist.yaml"


@pytest.fixture(autouse=True)
def no_external_keys(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    """Đảm bảo test chạy đúng nhánh fail-closed thật (không lỡ có key thật trong env
    máy chạy CI/dev), không phụ thuộc môi trường bên ngoài."""
    get_settings.cache_clear()
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("USPTO_INDEX_COVERAGE_COMPLETE", "false")
    yield
    get_settings.cache_clear()


async def make_term_with_seed(
    session: AsyncSession, text_display: str, risk_tier: str, niche: str = "wedding"
) -> int:
    seed = Seed(seed=text_display, niche=niche, risk_tier=risk_tier)
    session.add(seed)
    await session.flush()

    source = (
        await session.execute(select(Source).where(Source.name == "test_source"))
    ).scalar_one_or_none()
    if source is None:
        source = Source(name="test_source", kind="autocomplete", config={})
        session.add(source)
        await session.flush()
    raw = RawItem(source_id=source.id, external_id=f"raw-{text_display}", payload={})
    session.add(raw)
    await session.flush()

    norm = text_display.lower()
    term = Term(text_norm=norm, text_key=norm, text_display=text_display, niche=niche)
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
    await session.commit()
    return int(term.id)


async def test_franchise_term_is_blocked_regardless_of_tier(db_session: AsyncSession) -> None:
    # Acceptance: term chứa tên franchise trong blocklist -> blocked.
    term_id = await make_term_with_seed(db_session, "Star Wars T Shirt", risk_tier="T0")
    blocklist = load_blocklist(BLOCKLIST_FILE)

    result = await run_risk_gate(db_session, term_id, blocklist=blocklist)
    await db_session.commit()

    assert result.risk_level == "blocked"


async def test_blocked_candidate_never_becomes_eligible_for_export(
    db_session: AsyncSession,
) -> None:
    term_id = await make_term_with_seed(db_session, "Star Wars T Shirt", risk_tier="T0")
    blocklist = load_blocklist(BLOCKLIST_FILE)
    candidate = Candidate(term_id=term_id)
    db_session.add(candidate)
    await db_session.flush()

    await run_risk_gate_for_candidate(db_session, candidate, blocklist=blocklist)
    await db_session.commit()

    assert candidate.risk_level == "blocked"
    # Acceptance: không bao giờ tới được bước brief -- không có cách nào approve nó.
    with pytest.raises(ApprovalRequiredError):
        await approve_candidate(db_session, candidate, "T0", approved_by="someone")
    assert is_eligible_for_export(candidate, "T0") is False


async def test_t3_political_term_never_exportable_without_human_approval(
    db_session: AsyncSession,
) -> None:
    # Acceptance: term T3 (political) không bao giờ đạt approved mà không có approved_by.
    term_id = await make_term_with_seed(
        db_session, "veteran pride shirt", risk_tier="T3", niche="political_civic"
    )
    blocklist = load_blocklist(BLOCKLIST_FILE)
    candidate = Candidate(term_id=term_id)
    db_session.add(candidate)
    await db_session.flush()

    result = await run_risk_gate_for_candidate(db_session, candidate, blocklist=blocklist)
    await db_session.commit()

    # Không có USPTO/LLM key -> layer 2/3 review, layer 4 luôn review cho T2/T3.
    assert result.risk_tier == "T3"
    assert result.risk_level == "review"

    # Không thể approve mà thiếu approved_by, dù risk_level không phải "blocked".
    with pytest.raises(ApprovalRequiredError):
        await approve_candidate(db_session, candidate, "T3", approved_by=None)
    with pytest.raises(ApprovalRequiredError):
        await approve_candidate(db_session, candidate, "T3", approved_by="")
    assert candidate.status == "pending"  # vẫn chưa approved sau các lần thử thất bại
    assert is_eligible_for_export(candidate, "T3") is False

    # Có approved_by thật thì mới approve được.
    await approve_candidate(db_session, candidate, "T3", approved_by="admin@example.com")
    await db_session.commit()
    assert candidate.status == "approved"
    assert candidate.approved_by == "admin@example.com"
    assert is_eligible_for_export(candidate, "T3") is True


async def test_t0_clean_generic_term_auto_eligible_without_human(
    db_session: AsyncSession,
) -> None:
    term_id = await make_term_with_seed(db_session, "photo collage blanket", risk_tier="T0")
    blocklist = load_blocklist(BLOCKLIST_FILE)
    candidate = Candidate(term_id=term_id)
    db_session.add(candidate)
    await db_session.flush()

    result = await run_risk_gate_for_candidate(db_session, candidate, blocklist=blocklist)
    await db_session.commit()

    assert result.risk_level == "low"
    await approve_candidate(db_session, candidate, "T0", approved_by=None)
    await db_session.commit()
    assert is_eligible_for_export(candidate, "T0") is True


async def test_t0_term_with_proper_noun_needs_review_not_auto_pass(
    db_session: AsyncSession,
) -> None:
    # "Auto-approve nếu không có danh từ riêng" — có tên riêng thì KHÔNG auto pass.
    term_id = await make_term_with_seed(db_session, "Gift For Sarah Wedding", risk_tier="T0")
    blocklist = load_blocklist(BLOCKLIST_FILE)

    result = await run_risk_gate(db_session, term_id, blocklist=blocklist)
    await db_session.commit()

    assert result.risk_level == "review"


async def test_t1_term_without_uspto_key_is_review_not_pass(db_session: AsyncSession) -> None:
    term_id = await make_term_with_seed(
        db_session, "nurse humor shirt", risk_tier="T1", niche="occupation_humor"
    )
    blocklist = load_blocklist(BLOCKLIST_FILE)

    result = await run_risk_gate(db_session, term_id, blocklist=blocklist)
    await db_session.commit()

    # Lớp 2 bắt buộc cho T1, không có key -> review. KHÔNG BAO GIỜ "low"/pass khi
    # thiếu key — đây là bài test cốt lõi của toàn bộ nguyên tắc fail-closed.
    assert result.risk_level == "review"


async def test_risk_tier_defaults_conservatively_when_term_has_no_seed(
    db_session: AsyncSession,
) -> None:
    term = Term(text_norm="orphan term", text_key="orphan term", text_display="Orphan Term")
    db_session.add(term)
    await db_session.commit()

    tier = await determine_risk_tier(db_session, term.id)

    assert tier == "T2"  # fail-closed: không rõ nguồn gốc -> coi như rủi ro cao


async def test_risk_tier_uses_max_across_multiple_seeds(db_session: AsyncSession) -> None:
    seed_low = Seed(seed="wedding sign", niche="wedding", risk_tier="T0")
    seed_high = Seed(seed="wedding sign pop culture edit", niche="pop_culture", risk_tier="T2")
    db_session.add_all([seed_low, seed_high])
    await db_session.flush()
    source = Source(name="multi_seed_source", kind="autocomplete", config={})
    db_session.add(source)
    await db_session.flush()
    raw = RawItem(source_id=source.id, external_id="raw-multi", payload={})
    db_session.add(raw)
    await db_session.flush()
    term = Term(text_norm="shared term", text_key="shared term", text_display="Shared Term")
    db_session.add(term)
    await db_session.flush()
    db_session.add_all(
        [
            TermObservation(
                term_id=term.id,
                source_id=source.id,
                seed_id=seed_low.id,
                observed_at=datetime.now(UTC),
                rank=1,
                raw_item_id=raw.id,
            ),
            TermObservation(
                term_id=term.id,
                source_id=source.id,
                seed_id=seed_high.id,
                observed_at=datetime.now(UTC),
                rank=2,
                raw_item_id=raw.id,
            ),
        ]
    )
    await db_session.commit()

    tier = await determine_risk_tier(db_session, term.id)

    assert tier == "T2"  # cao nhất trong hai seed, không phải T0


async def test_risk_flags_are_written_for_each_layer_run(db_session: AsyncSession) -> None:
    from sqlalchemy import select

    from scanner.core.models import RiskFlag

    term_id = await make_term_with_seed(
        db_session, "nurse humor shirt", risk_tier="T1", niche="occupation_humor"
    )
    blocklist = load_blocklist(BLOCKLIST_FILE)

    await run_risk_gate(db_session, term_id, blocklist=blocklist)
    await db_session.commit()

    flags = (
        (await db_session.execute(select(RiskFlag).where(RiskFlag.term_id == term_id)))
        .scalars()
        .all()
    )
    layers = {f.layer for f in flags}
    assert layers == {"blocklist", "uspto"}  # T1 chỉ bắt buộc lớp 1+2


async def test_uspto_result_cached_for_30_days_not_rechecked(db_session: AsyncSession) -> None:
    from datetime import timedelta

    from scanner.core.models import RiskFlag

    term_id = await make_term_with_seed(
        db_session, "nurse humor shirt", risk_tier="T1", niche="occupation_humor"
    )
    db_session.add(
        RiskFlag(
            term_id=term_id,
            layer="uspto",
            severity="block",
            evidence={"status": "LIVE", "cached_test": True},
            created_at=datetime.now(UTC) - timedelta(days=5),
        )
    )
    await db_session.commit()
    blocklist = load_blocklist(BLOCKLIST_FILE)

    result = await run_risk_gate(db_session, term_id, blocklist=blocklist)
    await db_session.commit()

    # Vẫn "review" tổng thể vì lớp khác chưa qua (blocklist pass, nhưng ta expect
    # verdict cache là block -> risk_level blocked do dùng lại cache).
    assert result.risk_level == "blocked"
