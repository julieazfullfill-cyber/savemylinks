"""Etsy CSV importer — KHÔNG PHẢI SCRAPER (rule 15, docs/SOURCES.md).

Etsy cấm screen-scraping và API chính thức không cho dữ liệu shop đối thủ. Dữ liệu Etsy
vào hệ thống qua CSV export từ tool bên thứ ba (eRank, Everbee, Alura) do người dùng tự
tải xuống và đưa vào — importer chỉ đọc file, không gọi Etsy dưới bất kỳ hình thức nào.

Đi qua đúng luồng raw_items bất biến + term_observations như mọi nguồn khác (rule 1):
một file CSV = một `raw_items` row (payload là tóm tắt file, không phải toàn bộ CSV —
tránh JSONB quá lớn), mỗi dòng CSV hợp lệ = một `term_observations` row, `source.kind
='import'`.

**Chưa verify được với file export thật** từ eRank/Everbee/Alura trong phiên build này
— ba tool này cần tài khoản trả phí gắn với một shop Etsy thật để xuất file, không có
cách nào lấy mẫu thật mà không có tài khoản đó. Vì vậy importer KHÔNG hardcode schema
cột cố định của một tool cụ thể (sẽ là đoán mò, đúng thứ CLAUDE.md cấm) — tự nhận diện
cột theo tên phổ biến giữa các tool (case-insensitive), và cho phép ép tên cột bằng
`--term-column`/`--value-column` khi tự nhận diện sai. **Cần xác nhận lại cách nhận
diện cột này với file thật đầu tiên** trước khi tin tưởng hoàn toàn.
"""

import csv
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.log import get_logger
from scanner.core.models import RawItem as RawItemRow
from scanner.core.models import Source, TermObservation
from scanner.pipeline.collect import CollectStats, TermResolver

log = get_logger(__name__)

SOURCE_NAME = "etsy_csv_import"

# Tên cột phổ biến quan sát được trên các tool Etsy SEO (eRank, Everbee, Alura) —
# CHƯA đối chiếu với file thật, xem cảnh báo ở docstring module.
TERM_COLUMN_ALIASES = ("keyword", "search term", "term", "query", "tag", "tags")
VALUE_COLUMN_ALIASES = (
    "searches",
    "search volume",
    "avg. searches",
    "avg searches",
    "monthly searches",
    "volume",
    "search volume (avg)",
    "avg. monthly searches",
)


@dataclass(frozen=True)
class EtsyImportRow:
    term: str
    value: Decimal | None
    row_number: int


def _find_column(
    fieldnames: list[str], aliases: tuple[str, ...], override: str | None
) -> str | None:
    if override:
        return override if override in fieldnames else None
    lower_map = {f.strip().lower(): f for f in fieldnames}
    for alias in aliases:
        if alias in lower_map:
            return lower_map[alias]
    return None


def parse_etsy_csv(
    path: str | Path,
    *,
    term_column: str | None = None,
    value_column: str | None = None,
) -> list[EtsyImportRow]:
    """Thuần, không I/O DB — test được offline."""
    with Path(path).open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        term_col = _find_column(fieldnames, TERM_COLUMN_ALIASES, term_column)
        if term_col is None:
            raise ValueError(
                f"Không tìm thấy cột keyword trong header {fieldnames} — "
                "dùng --term-column để chỉ định thủ công"
            )
        value_col = _find_column(fieldnames, VALUE_COLUMN_ALIASES, value_column)
        if value_column and value_col is None:
            raise ValueError(f"Không tìm thấy cột '{value_column}' trong header {fieldnames}")

        rows: list[EtsyImportRow] = []
        for i, raw_row in enumerate(reader, start=2):  # dòng 1 là header
            term = (raw_row.get(term_col) or "").strip()
            if not term:
                continue
            value: Decimal | None = None
            if value_col:
                raw_value = (raw_row.get(value_col) or "").strip().replace(",", "")
                if raw_value and raw_value.upper() not in ("N/A", "NA", "-", ""):
                    try:
                        value = Decimal(raw_value)
                    except InvalidOperation:
                        log.warning("import_etsy.bad_value", row=i, value=raw_value)
            rows.append(EtsyImportRow(term=term, value=value, row_number=i))
        return rows


@dataclass
class ImportStats:
    file: str
    rows_parsed: int = 0
    observations: int = 0
    new_terms: int = 0
    duplicate_file: bool = False

    def as_dict(self) -> dict[str, int | str | bool]:
        return {
            "file": self.file,
            "rows_parsed": self.rows_parsed,
            "observations": self.observations,
            "new_terms": self.new_terms,
            "duplicate_file": self.duplicate_file,
        }


async def _ensure_source(session: AsyncSession) -> int:
    stmt = (
        pg_insert(Source)
        .values(name=SOURCE_NAME, kind="import", config={})
        .on_conflict_do_nothing(index_elements=[Source.name])
    )
    await session.execute(stmt)
    source_id = await session.scalar(select(Source.id).where(Source.name == SOURCE_NAME))
    assert source_id is not None
    return int(source_id)


async def import_etsy_csv(
    session: AsyncSession,
    path: str | Path,
    *,
    term_column: str | None = None,
    value_column: str | None = None,
) -> ImportStats:
    """Đọc file CSV, ghi raw_items (1 dòng/file) + term_observations (1 dòng/keyword).

    Import lại đúng file trong cùng ngày không sinh dòng trùng — cùng cơ chế
    `unique(source_id, external_id)` như mọi nguồn khác (rule 3).
    """
    file_name = Path(path).name
    rows = parse_etsy_csv(path, term_column=term_column, value_column=value_column)
    stats = ImportStats(file=file_name, rows_parsed=len(rows))
    if not rows:
        log.warning("import_etsy.no_rows", file=file_name)
        return stats

    source_id = await _ensure_source(session)
    imported_at = datetime.now(UTC)
    external_id = f"{file_name}|{imported_at.date().isoformat()}"

    raw_stmt = (
        pg_insert(RawItemRow)
        .values(
            source_id=source_id,
            external_id=external_id,
            payload={"file": file_name, "rows_parsed": len(rows)},
            fetched_at=imported_at,
        )
        .on_conflict_do_nothing(index_elements=[RawItemRow.source_id, RawItemRow.external_id])
        .returning(RawItemRow.id)
    )
    raw_id = await session.scalar(raw_stmt)
    if raw_id is None:
        stats.duplicate_file = True
        log.warning("import_etsy.duplicate_file", file=file_name)
        return stats

    collect_stats = CollectStats(source=SOURCE_NAME)
    resolver = TermResolver(session=session, stats=collect_stats)
    for row in rows:
        try:
            term_id = await resolver.resolve(row.term, None, None)
        except ValueError:
            continue
        session.add(
            TermObservation(
                term_id=term_id,
                source_id=source_id,
                seed_id=None,
                observed_at=imported_at,
                rank=None,
                value=row.value,
                raw_item_id=raw_id,
            )
        )
        stats.observations += 1

    stats.new_terms = collect_stats.new_terms
    log.info("import_etsy.done", **stats.as_dict())
    return stats
