"""Test Lớp 2 (USPTO) — tra local index (bảng uspto_trademarks), không gọi mạng thật.
Cần Postgres đã migrate; không có thì skip. Xem docstring pipeline/risk.py +
pipeline/uspto_index.py cho lý do dùng local index thay live API (tài khoản
USPTO.gov + MFA bắt buộc, đã xác nhận thật, không phải đoán)."""

from datetime import date

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.config import get_settings
from scanner.core.models import UsptoTrademark
from scanner.pipeline.risk import check_uspto

pytestmark = pytest.mark.db


@pytest.fixture(autouse=True)
def reset_settings():  # type: ignore[no-untyped-def]
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _add_mark(
    session: AsyncSession,
    serial: str,
    mark_norm: str,
    status_code: str,
    status_category: str,
    us_classes: list[str] | None = None,
) -> None:
    session.add(
        UsptoTrademark(
            serial_number=serial,
            mark_identification=mark_norm,
            mark_norm=mark_norm,
            status_code=status_code,
            status_category=status_category,
            us_classes=us_classes or ["025"],
            intl_classes=[],
            source_file="test-fixture",
            filing_date=date(2026, 1, 1),
        )
    )
    await session.commit()


async def test_live_match_in_relevant_class_blocks(db_session: AsyncSession) -> None:
    await _add_mark(db_session, "1", "grumpy cat shirt", "700", "live")

    result = await check_uspto(db_session, term_id=1, term_text="grumpy cat shirt")

    assert result.verdict == "block"
    assert result.evidence["status"] == "LIVE"


async def test_dead_match_passes_but_logs(db_session: AsyncSession) -> None:
    await _add_mark(db_session, "2", "old defunct brand", "606", "dead")

    result = await check_uspto(db_session, term_id=1, term_text="old defunct brand")

    assert result.verdict == "pass"
    assert result.evidence["status"] == "DEAD"


async def test_match_in_irrelevant_class_is_ignored(db_session: AsyncSession) -> None:
    # Đăng ký thật nhưng lớp không liên quan (điện tử, 009) -> không tính.
    await _add_mark(
        db_session, "3", "some electronics brand", "700", "live", us_classes=["009"]
    )

    result = await check_uspto(db_session, term_id=1, term_text="some electronics brand")

    # Không match lớp liên quan -> coi như không tìm thấy -> review (index chưa xác
    # nhận phủ đủ, KHÔNG được tự suy ra "pass" chỉ vì record duy nhất tìm được bị lọc).
    assert result.verdict == "review"


async def test_unknown_status_category_is_review_not_pass(db_session: AsyncSession) -> None:
    await _add_mark(db_session, "4", "ambiguous status term", "625", "unknown")

    result = await check_uspto(db_session, term_id=1, term_text="ambiguous status term")

    assert result.verdict == "review"


async def test_no_match_and_incomplete_coverage_is_review_not_pass(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("USPTO_INDEX_COVERAGE_COMPLETE", "false")
    get_settings.cache_clear()

    result = await check_uspto(db_session, term_id=1, term_text="term nowhere in index")

    # Acceptance cốt lõi: absence of evidence trong index CHƯA đầy đủ không phải
    # evidence of absence -- không bao giờ tự suy ra "pass" khi chưa xác nhận phủ đủ.
    assert result.verdict == "review"


async def test_no_match_and_confirmed_full_coverage_passes(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("USPTO_INDEX_COVERAGE_COMPLETE", "true")
    get_settings.cache_clear()

    result = await check_uspto(db_session, term_id=1, term_text="term nowhere in index")

    assert result.verdict == "pass"
    assert result.evidence["status"] == "NONE"


async def test_exact_normalized_phrase_matches_regardless_of_case_punctuation(
    db_session: AsyncSession,
) -> None:
    # mark_norm được nạp qua cùng normalize() với term -- "Grumpy Cat!" và "grumpy cat"
    # phải khớp nhau qua bản đã chuẩn hoá.
    await _add_mark(db_session, "5", "grumpy cat", "700", "live")

    result = await check_uspto(db_session, term_id=1, term_text="Grumpy Cat!")

    assert result.verdict == "block"
