"""Test thuần cho parser HTML + công thức saturation — không đụng DB, không đụng mạng.

Fixture lấy từ response thật của amazon.com/s?k=<term> (2026-09-14), đã cắt gọn còn
phần chứa markup thật xung quanh số kết quả — xem docstring pipeline/enrich.py.
"""

from decimal import Decimal
from pathlib import Path

import pytest

from scanner.pipeline.enrich import parse_competing_listings, saturation_from_count

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_parses_approximate_large_count() -> None:
    # "1-48 of over 3,000 results for" — response thật cho seed cạnh tranh cao.
    assert parse_competing_listings(load("amazon_search_over.html")) == 3000


def test_parses_exact_small_count() -> None:
    # "27 results for" — response thật cho seed rất ngách.
    assert parse_competing_listings(load("amazon_search_exact.html")) == 27


def test_parses_zero_results() -> None:
    assert parse_competing_listings(load("amazon_search_zero.html")) == 0


def test_unrecognized_structure_returns_none() -> None:
    assert parse_competing_listings("<html><body>gì đó không liên quan</body></html>") is None


def test_saturation_zero_listings_is_zero() -> None:
    assert saturation_from_count(0) == Decimal("0")


def test_saturation_increases_monotonically_with_count() -> None:
    low = saturation_from_count(10)
    mid = saturation_from_count(1000)
    high = saturation_from_count(50_000)
    assert low < mid < high


def test_saturation_caps_at_one() -> None:
    assert saturation_from_count(50_000) <= Decimal("1")
    assert saturation_from_count(10_000_000) == Decimal("1")


@pytest.mark.parametrize("count", [1, 27, 3000, 50_000, 200_000])
def test_saturation_always_in_valid_range(count: int) -> None:
    score = saturation_from_count(count)
    assert Decimal("0") <= score <= Decimal("1")
