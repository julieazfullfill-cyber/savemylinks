"""Test parser + ETL bulk XML USPTO. Fixture `uspto_bulk_sample.xml` là 3 <case-file>
THẬT trích nguyên văn từ file bulk XML người dùng tự tải từ USPTO (không phải dữ liệu
tự dựng) — một live (class 021, liên quan risk gate), một dead (abandoned), một
unknown (misassigned serial number, status-code 622)."""

from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import UsptoBulkFile, UsptoTrademark
from scanner.pipeline.uspto_index import iter_case_files, load_bulk_file, parse_case_file
from xml.etree.ElementTree import iterparse

FIXTURE = Path(__file__).parent / "fixtures" / "uspto_bulk_sample.xml"


def _case_files() -> list:
    return [elem for _e, elem in iterparse(FIXTURE, events=("end",)) if elem.tag == "case-file"]


def test_parse_case_file_extracts_live_record_with_relevant_class() -> None:
    elems = _case_files()
    record = parse_case_file(elems[0])
    assert record is not None
    assert record.serial_number == "99698239"
    assert record.mark_identification == "THE WASHINGTON HERALD"
    assert record.mark_norm == "the washington herald"
    assert record.status_category == "live"
    assert "021" in record.us_classes


def test_parse_case_file_extracts_dead_record() -> None:
    elems = _case_files()
    record = parse_case_file(elems[1])
    assert record is not None
    assert record.status_code == "601"
    assert record.status_category == "dead"


def test_parse_case_file_extracts_unknown_record() -> None:
    elems = _case_files()
    record = parse_case_file(elems[2])
    assert record is not None
    assert record.status_code == "622"
    assert record.status_category == "unknown"


def test_parse_case_file_returns_none_without_mark_identification() -> None:
    from xml.etree.ElementTree import fromstring

    elem = fromstring(
        "<case-file><serial-number>1</serial-number>"
        "<case-file-header><status-code>700</status-code></case-file-header></case-file>"
    )
    assert parse_case_file(elem) is None


def test_iter_case_files_streams_all_records_from_fixture() -> None:
    records = list(iter_case_files(FIXTURE))
    assert len(records) == 3
    assert {r.status_category for r in records} == {"live", "dead", "unknown"}


@pytest.mark.db
async def test_load_bulk_file_inserts_rows_and_manifest(db_session: AsyncSession) -> None:
    stats = await load_bulk_file(db_session, FIXTURE)

    assert stats.parsed == 3
    rows = (await db_session.execute(select(UsptoTrademark))).scalars().all()
    assert len(rows) == 3
    manifest = await db_session.get(UsptoBulkFile, FIXTURE.name)
    assert manifest is not None
    assert manifest.record_count == 3


@pytest.mark.db
async def test_load_bulk_file_is_idempotent_upsert(db_session: AsyncSession) -> None:
    await load_bulk_file(db_session, FIXTURE)
    await load_bulk_file(db_session, FIXTURE)

    rows = (await db_session.execute(select(UsptoTrademark))).scalars().all()
    assert len(rows) == 3  # không sinh trùng khi nạp lại cùng file
