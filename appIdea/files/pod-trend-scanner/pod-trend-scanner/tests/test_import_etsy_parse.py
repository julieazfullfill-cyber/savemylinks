"""Test thuần cho parser CSV Etsy — không đụng DB, không đụng mạng (rule 15/18).

**Lưu ý:** fixture CSV trong tests/fixtures/etsy_*_style.csv là dữ liệu TỰ DỰNG mô
phỏng theo tên cột phổ biến được biết đến của eRank/Everbee/Alura, KHÔNG phải file
export thật (ba tool này cần tài khoản trả phí để xuất) — xem cảnh báo ở docstring
pipeline/import_etsy.py. Test này verify cơ chế tự nhận diện cột hoạt động đúng với
các biến thể tên cột hợp lý, không khẳng định khớp 100% format thật.
"""

from decimal import Decimal
from pathlib import Path

import pytest

from scanner.pipeline.import_etsy import parse_etsy_csv

FIXTURES = Path(__file__).parent / "fixtures"


def test_erank_style_headers_auto_detected() -> None:
    rows = parse_etsy_csv(FIXTURES / "etsy_erank_style.csv")
    assert len(rows) == 3
    assert rows[0].term == "bridesmaid proposal box"
    assert rows[0].value == Decimal("3200")


def test_everbee_style_headers_auto_detected() -> None:
    rows = parse_etsy_csv(FIXTURES / "etsy_everbee_style.csv")
    assert len(rows) == 3
    by_term = {r.term: r for r in rows}
    assert by_term["funny dad shirt"].value == Decimal("4100")


def test_everbee_style_blank_value_still_imports_term() -> None:
    rows = parse_etsy_csv(FIXTURES / "etsy_everbee_style.csv")
    by_term = {r.term: r for r in rows}
    assert by_term["custom family portrait"].value is None


def test_alura_style_headers_auto_detected() -> None:
    rows = parse_etsy_csv(FIXTURES / "etsy_alura_style.csv")
    assert len(rows) == 2
    by_term = {r.term: r for r in rows}
    assert by_term["bachelorette party favors"].value == Decimal("900")
    assert "engagement announcement, custom" in by_term  # dấu phẩy trong ngoặc kép giữ nguyên


def test_row_numbers_start_at_two_after_header() -> None:
    rows = parse_etsy_csv(FIXTURES / "etsy_erank_style.csv")
    assert [r.row_number for r in rows] == [2, 3, 4]


def test_missing_term_column_raises_clear_error(tmp_path: Path) -> None:
    csv_path = tmp_path / "bad.csv"
    csv_path.write_text("Foo,Bar\n1,2\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Không tìm thấy cột keyword"):
        parse_etsy_csv(csv_path)


def test_term_column_override_works(tmp_path: Path) -> None:
    csv_path = tmp_path / "custom.csv"
    csv_path.write_text("MyWeirdColumn,Vol\nsome keyword,50\n", encoding="utf-8")
    rows = parse_etsy_csv(csv_path, term_column="MyWeirdColumn", value_column="Vol")
    assert rows == [make_expected_row("some keyword", Decimal("50"), 2)]


def test_invalid_value_column_override_raises(tmp_path: Path) -> None:
    csv_path = tmp_path / "custom2.csv"
    csv_path.write_text("Keyword,Vol\nterm,50\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Không tìm thấy cột"):
        parse_etsy_csv(csv_path, value_column="DoesNotExist")


def test_blank_rows_and_whitespace_only_terms_skipped(tmp_path: Path) -> None:
    csv_path = tmp_path / "blanks.csv"
    csv_path.write_text("Keyword,Searches\nreal term,10\n   ,20\n,30\n", encoding="utf-8")
    rows = parse_etsy_csv(csv_path)
    assert len(rows) == 1
    assert rows[0].term == "real term"


def test_non_numeric_value_is_dropped_but_term_kept(tmp_path: Path) -> None:
    csv_path = tmp_path / "weird_value.csv"
    csv_path.write_text("Keyword,Searches\nterm one,not a number\n", encoding="utf-8")
    rows = parse_etsy_csv(csv_path)
    assert len(rows) == 1
    assert rows[0].term == "term one"
    assert rows[0].value is None


def make_expected_row(term: str, value: Decimal | None, row_number: int):  # type: ignore[no-untyped-def]
    from scanner.pipeline.import_etsy import EtsyImportRow

    return EtsyImportRow(term=term, value=value, row_number=row_number)
