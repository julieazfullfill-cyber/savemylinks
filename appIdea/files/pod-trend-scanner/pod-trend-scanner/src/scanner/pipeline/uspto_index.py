"""Nạp bulk data XML USPTO ("Trademark Applications Daily", DTD V2.0) vào bảng
`uspto_trademarks` — index nội bộ thay cho live API (docs/RISK_POLICY.md Lớp 2).

Vì sao có file này: live API (api.uspto.gov) và cả trang browse bulk data
(data.uspto.gov) đều yêu cầu tài khoản USPTO.gov + MFA kể từ 2026-06-18 (xác nhận
thật qua Playwright, không phải đoán). Người dùng hệ thống này tự tải file bulk từ
https://www.uspto.gov/trademarks/apply/check-status-view-documents/trademark-bulk-data
(không cần key) rồi đưa cho lệnh này nạp vào Postgres.

**Phạm vi dữ liệu**: bộ "Trademark Full Text XML Data (No Images) – Annual
Applications" của USPTO gồm NHIỀU file (91 file tại thời điểm viết), tên dạng
`apc<fromdate>-<todate>-<phần>.xml` hoặc `.zip` (mỗi zip chứa 1 xml). Một file KHÔNG
PHẢI toàn bộ dữ liệu. `check_uspto` (pipeline/risk.py) chỉ trả "pass" khi không tìm
thấy match VÀ `settings.uspto_index_coverage_complete` là True (operator tự xác nhận
đã nạp đủ toàn bộ bộ dữ liệu) — thiếu xác nhận đó, "không tìm thấy" vẫn rơi vào
"review" (fail-closed: absence of evidence trong dữ liệu chưa đầy đủ không phải
evidence of absence). Dùng `index_status()` / `scanner uspto-index-status` để biết đã
nạp bao nhiêu file trước khi quyết định set cờ đó.

**Nạp nhiều file dễ dàng**: `scanner uspto-index --path <thư mục>` tự động quét cả
`*.xml` lẫn `*.zip` trong thư mục đó (không cần tự giải nén, không cần liệt kê từng
file), bỏ qua file đã có trong manifest `uspto_bulk_files` (idempotent — chạy lại an
toàn khi có thêm file mới rơi vào cùng thư mục, ví dụ USPTO ra thêm dữ liệu sau này).
Dùng `--force` để nạp lại file đã có (nếu nghi ngờ dữ liệu gốc đã cập nhật).

XML file thật có thể hàng trăm MB -> dùng iterparse, không load hết vào RAM, và xoá
element khỏi cây ngay sau khi xử lý xong mỗi <case-file>.
"""

import zipfile
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import IO, Literal
from xml.etree.ElementTree import Element, iterparse

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.log import get_logger
from scanner.core.normalize import normalize
from scanner.pipeline.uspto_status_codes import classify_case_status

log = get_logger(__name__)

INSERT_BATCH_SIZE = 2000


@dataclass(frozen=True)
class TrademarkRecord:
    serial_number: str
    registration_number: str | None
    mark_identification: str | None
    mark_norm: str
    status_code: str
    status_category: str
    status_date: date | None
    filing_date: date | None
    registration_date: date | None
    us_classes: tuple[str, ...]
    intl_classes: tuple[str, ...]


def _text(parent: Element, tag: str) -> str | None:
    child = parent.find(tag)
    if child is None or child.text is None:
        return None
    value = child.text.strip()
    return value or None


def _parse_date(raw: str | None) -> date | None:
    """USPTO date format YYYYMMDD. '00000000' hoặc tháng/ngày 00 (ngày không rõ trong
    nguồn gốc, xem DTD comment first-use-anywhere-date) -> None, không đoán."""
    if not raw or len(raw) != 8 or not raw.isdigit():
        return None
    year, month, day = int(raw[:4]), int(raw[4:6]), int(raw[6:8])
    if month == 0 or day == 0:
        return None
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_case_file(case_file: Element) -> TrademarkRecord | None:
    """Thuần, test được offline với fixture XML thật trích từ file bulk. Trả None nếu
    thiếu serial-number hoặc mark-identification (không đủ để tra cứu)."""
    serial = _text(case_file, "serial-number")
    if not serial:
        return None
    header = case_file.find("case-file-header")
    mark = _text(header, "mark-identification") if header is not None else None
    if not mark:
        return None
    mark_norm, _ = normalize(mark)
    if not mark_norm:
        return None

    status_code = (_text(header, "status-code") if header is not None else None) or "000"
    registration_number = _text(case_file, "registration-number")
    if registration_number == "0000000":
        registration_number = None

    us_classes: list[str] = []
    intl_classes: list[str] = []
    classifications = case_file.find("classifications")
    if classifications is not None:
        for classification in classifications.findall("classification"):
            for el in classification.findall("us-code"):
                if el.text and el.text.strip():
                    us_classes.append(el.text.strip())
            for el in classification.findall("international-code"):
                if el.text and el.text.strip():
                    intl_classes.append(el.text.strip())

    return TrademarkRecord(
        serial_number=serial,
        registration_number=registration_number,
        mark_identification=mark,
        mark_norm=mark_norm,
        status_code=status_code,
        status_category=classify_case_status(status_code),
        status_date=_parse_date(_text(header, "status-date") if header is not None else None),
        filing_date=_parse_date(_text(header, "filing-date") if header is not None else None),
        registration_date=_parse_date(
            _text(header, "registration-date") if header is not None else None
        ),
        us_classes=tuple(dict.fromkeys(us_classes)),
        intl_classes=tuple(dict.fromkeys(intl_classes)),
    )


def iter_case_files(source: str | Path | IO[bytes]) -> Iterator[TrademarkRecord]:
    """Stream-parse: chỉ giữ 1 <case-file> trong bộ nhớ tại một thời điểm. `elem.clear()`
    sau mỗi case-file để không tích luỹ cây XML khổng lồ (file thật ~400MB+). `source`
    có thể là đường dẫn HOẶC file-like object (vd. entry mở từ trong 1 file .zip)."""
    context = iterparse(source, events=("end",))
    for _event, elem in context:
        if elem.tag != "case-file":
            continue
        record = parse_case_file(elem)
        if record is not None:
            yield record
        elem.clear()


def iter_source_files(path: Path) -> Iterator[tuple[str, str | Path | IO[bytes]]]:
    """Với 1 file `.xml`: yield thẳng (tên file, path). Với 1 file `.zip`: giải nén
    trong bộ nhớ, yield (tên entry, file-like) cho từng `*.xml` bên trong — USPTO phân
    phối bulk data dạng zip, không cần bắt người dùng tự giải nén 91 file trước."""
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".xml")]
            for name in names:
                with zf.open(name) as f:
                    yield name, f
    else:
        yield path.name, path


def discover_bulk_paths(inputs: Iterable[str | Path]) -> list[Path]:
    """Mở rộng thư mục thành danh sách file `.xml`/`.zip` (sort để chạy lại có thứ tự
    ổn định); giữ nguyên file lẻ. Cho phép `--path` trỏ thẳng vào 1 thư mục chứa toàn
    bộ 91 file thay vì phải liệt kê từng file thủ công."""
    found: list[Path] = []
    for raw in inputs:
        p = Path(raw)
        if p.is_dir():
            found.extend(sorted(p.glob("*.xml")))
            found.extend(sorted(p.glob("*.zip")))
        else:
            found.append(p)
    seen: set[Path] = set()
    result: list[Path] = []
    for p in found:
        if p not in seen:
            seen.add(p)
            result.append(p)
    return result


@dataclass
class LoadStats:
    filename: str
    parsed: int = 0
    status: Literal["loaded", "skipped_already_loaded"] = "loaded"

    def as_dict(self) -> dict[str, int | str]:
        return {"filename": self.filename, "parsed": self.parsed, "status": self.status}


_UPSERT_SQL = text(
    """
    INSERT INTO uspto_trademarks (
        serial_number, registration_number, mark_identification, mark_norm,
        status_code, status_category, status_date, filing_date, registration_date,
        us_classes, intl_classes, source_file, loaded_at
    ) VALUES (
        :serial_number, :registration_number, :mark_identification, :mark_norm,
        :status_code, :status_category, :status_date, :filing_date, :registration_date,
        :us_classes, :intl_classes, :source_file, now()
    )
    ON CONFLICT (serial_number) DO UPDATE SET
        registration_number = EXCLUDED.registration_number,
        mark_identification = EXCLUDED.mark_identification,
        mark_norm = EXCLUDED.mark_norm,
        status_code = EXCLUDED.status_code,
        status_category = EXCLUDED.status_category,
        status_date = EXCLUDED.status_date,
        filing_date = EXCLUDED.filing_date,
        registration_date = EXCLUDED.registration_date,
        us_classes = EXCLUDED.us_classes,
        intl_classes = EXCLUDED.intl_classes,
        source_file = EXCLUDED.source_file,
        loaded_at = now()
    """
)

_UPSERT_MANIFEST_SQL = text(
    """
    INSERT INTO uspto_bulk_files (filename, record_count, loaded_at)
    VALUES (:filename, :record_count, now())
    ON CONFLICT (filename) DO UPDATE SET
        record_count = EXCLUDED.record_count, loaded_at = now()
    """
)


async def _already_loaded_filenames(session: AsyncSession) -> set[str]:
    rows = await session.execute(text("SELECT filename FROM uspto_bulk_files"))
    return {row[0] for row in rows}


async def _load_entry(
    session: AsyncSession, entry_name: str, source: str | Path | IO[bytes]
) -> LoadStats:
    """Nạp một XML entry (file rời hoặc mở từ trong zip) vào `uspto_trademarks`, ghi
    1 dòng manifest. Upsert theo serial_number -> nạp lại an toàn, không sinh trùng."""
    stats = LoadStats(filename=entry_name)
    batch: list[dict[str, object]] = []

    async def flush() -> None:
        if not batch:
            return
        await session.execute(_UPSERT_SQL, batch)
        batch.clear()

    for record in iter_case_files(source):
        batch.append(
            {
                "serial_number": record.serial_number,
                "registration_number": record.registration_number,
                "mark_identification": record.mark_identification,
                "mark_norm": record.mark_norm,
                "status_code": record.status_code,
                "status_category": record.status_category,
                "status_date": record.status_date,
                "filing_date": record.filing_date,
                "registration_date": record.registration_date,
                "us_classes": list(record.us_classes),
                "intl_classes": list(record.intl_classes),
                "source_file": entry_name,
            }
        )
        stats.parsed += 1
        if len(batch) >= INSERT_BATCH_SIZE:
            await flush()
            if stats.parsed % 50_000 == 0:
                log.info("uspto_index.progress", file=entry_name, parsed=stats.parsed)

    await flush()
    await session.execute(
        _UPSERT_MANIFEST_SQL, {"filename": entry_name, "record_count": stats.parsed}
    )
    await session.commit()
    log.info("uspto_index.file_loaded", **stats.as_dict())
    return stats


async def load_path(
    session: AsyncSession, path: str | Path, *, force: bool = False
) -> list[LoadStats]:
    """Nạp một file `.xml`/`.zip` (thư mục cần mở rộng trước bằng `discover_bulk_paths`).
    `.zip` có thể chứa nhiều `.xml`, mỗi entry nạp + ghi manifest riêng. Bỏ qua entry
    đã có trong `uspto_bulk_files` trừ khi `force=True` — cho phép chạy lại lệnh trên
    cả thư mục nhiều lần (thêm file mới, hoặc nạp nốt phần còn thiếu) mà không tốn
    công xử lý lại file đã nạp."""
    p = Path(path)
    already = set() if force else await _already_loaded_filenames(session)
    results: list[LoadStats] = []
    for entry_name, source in iter_source_files(p):
        if entry_name in already:
            results.append(LoadStats(filename=entry_name, status="skipped_already_loaded"))
            continue
        results.append(await _load_entry(session, entry_name, source))
    return results


async def index_status(session: AsyncSession) -> dict[str, object]:
    """Tóm tắt local index: số file đã nạp, tổng record, breakdown theo status_category
    -- dùng để biết đã nạp gần đủ 91 file chưa trước khi set
    USPTO_INDEX_COVERAGE_COMPLETE=true."""
    files_loaded = (await session.execute(text("SELECT count(*) FROM uspto_bulk_files"))).scalar_one()
    total_records = (
        await session.execute(text("SELECT count(*) FROM uspto_trademarks"))
    ).scalar_one()
    by_status = (
        await session.execute(
            text("SELECT status_category, count(*) FROM uspto_trademarks GROUP BY status_category")
        )
    ).all()
    return {
        "files_loaded": int(files_loaded),
        "total_records": int(total_records),
        "by_status_category": {row[0]: int(row[1]) for row in by_status},
    }
