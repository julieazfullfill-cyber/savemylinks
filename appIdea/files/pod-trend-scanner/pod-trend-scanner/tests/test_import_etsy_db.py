"""Integration test cho pipeline/import_etsy.py. Cần Postgres đã migrate; không có thì skip."""

from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import RawItem as RawItemRow
from scanner.core.models import Source, Term, TermObservation
from scanner.pipeline.import_etsy import SOURCE_NAME, import_etsy_csv

pytestmark = pytest.mark.db

FIXTURES = Path(__file__).parent / "fixtures"


async def count(session: AsyncSession, model: object) -> int:
    return int(await session.scalar(select(func.count()).select_from(model)) or 0)  # type: ignore[arg-type]


async def test_import_creates_source_with_import_kind(db_session: AsyncSession) -> None:
    await import_etsy_csv(db_session, FIXTURES / "etsy_erank_style.csv")
    await db_session.commit()

    source = (
        await db_session.execute(select(Source).where(Source.name == SOURCE_NAME))
    ).scalar_one()
    assert source.kind == "import"


async def test_import_writes_one_raw_item_and_observations_per_row(
    db_session: AsyncSession,
) -> None:
    stats = await import_etsy_csv(db_session, FIXTURES / "etsy_erank_style.csv")
    await db_session.commit()

    assert stats.rows_parsed == 3
    assert stats.observations == 3
    assert await count(db_session, RawItemRow) == 1  # 1 file = 1 raw_item
    assert await count(db_session, TermObservation) == 3


async def test_reimporting_same_file_same_day_creates_no_duplicates(
    db_session: AsyncSession,
) -> None:
    await import_etsy_csv(db_session, FIXTURES / "etsy_erank_style.csv")
    await db_session.commit()
    raw_before = await count(db_session, RawItemRow)
    obs_before = await count(db_session, TermObservation)

    second = await import_etsy_csv(db_session, FIXTURES / "etsy_erank_style.csv")
    await db_session.commit()

    assert second.duplicate_file is True
    assert second.observations == 0
    assert await count(db_session, RawItemRow) == raw_before
    assert await count(db_session, TermObservation) == obs_before


async def test_imported_terms_have_no_seed_and_no_niche(db_session: AsyncSession) -> None:
    await import_etsy_csv(db_session, FIXTURES / "etsy_erank_style.csv")
    await db_session.commit()

    obs = (await db_session.execute(select(TermObservation))).scalars().all()
    assert all(o.seed_id is None and o.rank is None for o in obs)
    terms = (await db_session.execute(select(Term))).scalars().all()
    assert all(t.niche is None for t in terms)


async def test_term_already_seen_elsewhere_gets_merged_not_duplicated(
    db_session: AsyncSession,
) -> None:
    term = Term(
        text_norm="bridesmaid proposal box",
        text_key="bridesmaid box proposal",
        text_display="Bridesmaid Proposal Box",
        niche="wedding",
    )
    db_session.add(term)
    await db_session.commit()
    existing_term_count = await count(db_session, Term)

    await import_etsy_csv(db_session, FIXTURES / "etsy_erank_style.csv")
    await db_session.commit()

    # "bridesmaid proposal box" đã tồn tại -> gộp vào term cũ, chỉ 2 term mới được tạo
    # (custom photo blanket, personalized wedding sign) trong tổng 3 dòng CSV.
    assert await count(db_session, Term) == existing_term_count + 2


async def test_column_override_used_when_autodetect_would_fail(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    csv_path = tmp_path / "weird.csv"
    csv_path.write_text("MyKeyword,MyVolume\ncustom weird term,77\n", encoding="utf-8")

    stats = await import_etsy_csv(
        db_session, csv_path, term_column="MyKeyword", value_column="MyVolume"
    )
    await db_session.commit()

    assert stats.observations == 1
    term = (
        await db_session.execute(select(Term).where(Term.text_norm == "custom weird term"))
    ).scalar_one()
    obs = (
        await db_session.execute(
            select(TermObservation).where(TermObservation.term_id == term.id)
        )
    ).scalar_one()
    assert obs.value == 77
