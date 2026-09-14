"""Nạp bulk data XML USPTO ("Trademark Applications Daily", DTD V2.0) vào bảng
`uspto_trademarks` — index nội bộ thay cho live API (docs/RISK_POLICY.md Lớp 2).

Vì sao có file này: live API (api.uspto.gov) và cả trang browse bulk data
(data.uspto.gov) đều yêu cầu tài khoản USPTO.gov + MFA kể từ 2026-06-18 (xác nhận
thật qua Playwright, không phải đoán). Người dùng hệ thống này tự tải file bulk XML
từ https://www.uspto.gov/trademarks/apply/check-status-view-documents/trademark-bulk-data
(không cần key) rồi đưa cho lệnh này nạp vào Postgres.

**Cảnh báo phạm vi dữ liệu**: bộ "Trademark Full Text XML Data (No Images) – Annual
Applications" của USPTO gồm nhiều file, tên dạng `apc<fromdate>-<todate>-<phần>.xml`.
Một file KHÔNG PHẢI toàn bộ dữ liệu. `run_risk_gate`/`check_uspto` (pipeline/risk.py)
chỉ trả "pass" khi không tìm thấy match VÀ `settings.uspto_index_coverage_complete`
là True (operator tự xác nhận đã nạp đủ toàn bộ bộ dữ liệu) — thiếu xác nhận đó,
"không tìm thấy" vẫn rơi vào "review" (fail-closed: absence of evidence trong dữ
liệu chưa đầy đủ không phải evidence of absence).

XML file thật có thể hàng trăm MB -> dùng iterparse, không load hết vào RAM, và xoá
element khỏi cây ngay sau khi xử lý xong mỗi <case-file>.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from pathlib import Path
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


def iter_case_files(xml_path: str | Path) -> Iterator[TrademarkRecord]:
    """Stream-parse: chỉ giữ 1 <case-file> trong bộ nhớ tại một thời điểm. `root.clear()`
    sau mỗi case-file để không tích luỹ cây XML khổng lồ (file thật ~400MB+)."""
    context = iterparse(str(xml_path), events=("end",))
    for _event, elem in context:
        if elem.tag != "case-file":
            continue
        record = parse_case_file(elem)
        if record is not None:
            yield record
        elem.clear()


@dataclass
class LoadStats:
    filename: str
    parsed: int = 0
    skipped: int = 0

    def as_dict(self) -> dict[str, int | str]:
        return {"filename": self.filename, "parsed": self.parsed, "skipped": self.skipped}


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


async def load_bulk_file(session: AsyncSession, xml_path: str | Path) -> LoadStats:
    """Nạp một file XML vào `uspto_trademarks`, ghi manifest vào `uspto_bulk_files`.
    Upsert theo serial_number -> chạy lại cùng file (vd. bản cập nhật mới hơn) an toàn,
    không sinh trùng."""
    path = Path(xml_path)
    stats = LoadStats(filename=path.name)
    batch: list[dict[str, object]] = []

    async def flush() -> None:
        if not batch:
            return
        await session.execute(_UPSERT_SQL, batch)
        batch.clear()

    for record in iter_case_files(path):
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
                "source_file": path.name,
            }
        )
        stats.parsed += 1
        if len(batch) >= INSERT_BATCH_SIZE:
            await flush()
            if stats.parsed % 50_000 == 0:
                log.info("uspto_index.progress", file=path.name, parsed=stats.parsed)

    await flush()
    await session.execute(
        _UPSERT_MANIFEST_SQL, {"filename": path.name, "record_count": stats.parsed}
    )
    await session.commit()
    log.info("uspto_index.file_loaded", **stats.as_dict())
    return stats
