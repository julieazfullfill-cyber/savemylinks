"""Test parser + ETL bulk XML USPTO. Fixture `uspto_bulk_sample.xml` là 3 <case-file>
THẬT trích nguyên văn từ file bulk XML người dùng tự tải từ USPTO (không phải dữ liệu
tự dựng) — một live (class 021, liên quan risk gate), một dead (abandoned), một
unknown (misassigned serial number, status-code 622)."""

import zipfile
from pathlib import Path
from xml.etree.ElementTree import iterparse

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import UsptoBulkFile, UsptoTrademark
from scanner.pipeline.uspto_index import (
    discover_bulk_paths,
    index_status,
    iter_case_files,
    load_path,
    parse_case_file,
)

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


def test_discover_bulk_paths_expands_directory_to_xml_and_zip(tmp_path: Path) -> None:
    (tmp_path / "b.zip").write_bytes(b"")
    (tmp_path / "a.xml").write_bytes(b"")
    (tmp_path / "notes.txt").write_bytes(b"")

    found = discover_bulk_paths([tmp_path])

    assert [p.name for p in found] == ["a.xml", "b.zip"]  # sort, bỏ qua file khác đuôi


def test_discover_bulk_paths_keeps_explicit_files_as_is(tmp_path: Path) -> None:
    f = tmp_path / "one.xml"
    f.write_bytes(b"")

    assert discover_bulk_paths([f]) == [f]


def test_discover_bulk_paths_dedupes() -> None:
    assert discover_bulk_paths([FIXTURE, FIXTURE]) == [FIXTURE]


@pytest.mark.db
async def test_load_path_inserts_rows_and_manifest(db_session: AsyncSession) -> None:
    results = await load_path(db_session, FIXTURE)

    assert len(results) == 1
    assert results[0].parsed == 3
    assert results[0].status == "loaded"
    rows = (await db_session.execute(select(UsptoTrademark))).scalars().all()
    assert len(rows) == 3
    manifest = await db_session.get(UsptoBulkFile, FIXTURE.name)
    assert manifest is not None
    assert manifest.record_count == 3


@pytest.mark.db
async def test_load_path_skips_already_loaded_file_by_default(db_session: AsyncSession) -> None:
    await load_path(db_session, FIXTURE)
    results = await load_path(db_session, FIXTURE)

    assert results[0].status == "skipped_already_loaded"
    assert results[0].parsed == 0
    rows = (await db_session.execute(select(UsptoTrademark))).scalars().all()
    assert len(rows) == 3  # không nạp lại, không sinh trùng


@pytest.mark.db
async def test_load_path_force_reloads_already_loaded_file(db_session: AsyncSession) -> None:
    await load_path(db_session, FIXTURE)
    results = await load_path(db_session, FIXTURE, force=True)

    assert results[0].status == "loaded"
    assert results[0].parsed == 3
    rows = (await db_session.execute(select(UsptoTrademark))).scalars().all()
    assert len(rows) == 3  # upsert theo serial_number -- vẫn không sinh trùng


@pytest.mark.db
async def test_load_path_handles_zip_containing_one_xml(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    zip_path = tmp_path / "apc-bundle.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.write(FIXTURE, arcname="apc-inner-sample.xml")

    results = await load_path(db_session, zip_path)

    assert len(results) == 1
    assert results[0].filename == "apc-inner-sample.xml"  # tên entry bên trong zip
    assert results[0].parsed == 3
    rows = (await db_session.execute(select(UsptoTrademark))).scalars().all()
    assert len(rows) == 3
    manifest = await db_session.get(UsptoBulkFile, "apc-inner-sample.xml")
    assert manifest is not None


@pytest.mark.db
async def test_index_status_reports_files_records_and_breakdown(
    db_session: AsyncSession,
) -> None:
    await load_path(db_session, FIXTURE)

    status = await index_status(db_session)

    assert status["files_loaded"] == 1
    assert status["total_records"] == 3
    assert status["by_status_category"] == {"live": 1, "dead": 1, "unknown": 1}
