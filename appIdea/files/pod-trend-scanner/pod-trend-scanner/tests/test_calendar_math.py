"""Test thuần cho cửa sổ sản xuất — không đụng DB."""

from datetime import date

from scanner.core.models import Occasion
from scanner.pipeline.calendar import _peak_start, _production_window


def make_occasion(peak_months: list[int], lead_weeks: int, niches: list[str] | None = None) -> Occasion:
    occ = Occasion(name="test", peak_months=peak_months, lead_weeks=lead_weeks, niches=niches or ["x"])
    return occ


def test_peak_start_uses_smallest_month() -> None:
    assert _peak_start([5, 6, 7, 8], 2026) == date(2026, 5, 1)
    assert _peak_start([10], 2026) == date(2026, 10, 1)


def test_acceptance_example_december_matches_wedding_season() -> None:
    # peak_months 5-8, lead 8-12 tuần (chọn 10) — hỏi vào tháng 12 phải khớp.
    occ = make_occasion([5, 6, 7, 8], lead_weeks=10)
    window = _production_window(occ, date(2026, 12, 15))
    assert window is not None
    window_start, window_end = window
    assert window_start <= date(2026, 12, 15) <= window_end


def test_window_bounds_are_peak_start_minus_lead_and_minus_double_lead() -> None:
    occ = make_occasion([5, 6, 7, 8], lead_weeks=10)
    window = _production_window(occ, date(2026, 12, 15))
    assert window is not None
    window_start, window_end = window
    # peak_start năm sau (2027-05-01) vì đang hỏi cuối năm 2026.
    from datetime import timedelta

    peak_start = date(2027, 5, 1)
    assert window_end == peak_start - timedelta(weeks=10)
    assert window_start == peak_start - timedelta(weeks=20)


def test_too_early_returns_none() -> None:
    # Tháng 6 thì còn quá sớm cho peak tháng 5-8 (window đã đóng từ tháng 2).
    occ = make_occasion([5, 6, 7, 8], lead_weeks=10)
    assert _production_window(occ, date(2026, 6, 15)) is None


def test_too_late_within_same_year_falls_to_next_year_window() -> None:
    # Sau khi cửa sổ năm nay đóng (~20/2) và trước cửa sổ năm sau (~giữa tháng 12),
    # không có occasion nào khớp.
    occ = make_occasion([5, 6, 7, 8], lead_weeks=10)
    assert _production_window(occ, date(2026, 6, 1)) is None
    assert _production_window(occ, date(2026, 11, 1)) is None


def test_single_peak_month_window() -> None:
    # peak tháng 2, lead 6 tuần -> cửa sổ [peak_start-12wk, peak_start-6wk].
    # Với peak_start=2026-02-01: cửa sổ là 2025-11-09 .. 2025-12-21.
    occ = make_occasion([2], lead_weeks=6)
    assert _production_window(occ, date(2025, 12, 1)) is not None
    assert _production_window(occ, date(2026, 1, 5)) is None  # đã trễ so với cửa sổ


def test_exact_boundary_dates_are_inclusive() -> None:
    occ = make_occasion([5], lead_weeks=10)
    peak_start = date(2026, 5, 1)
    from datetime import timedelta

    window_end = peak_start - timedelta(weeks=10)
    window_start = peak_start - timedelta(weeks=20)
    assert _production_window(occ, window_end) is not None
    assert _production_window(occ, window_start) is not None
    assert _production_window(occ, window_end + timedelta(days=1)) is None
    assert _production_window(occ, window_start - timedelta(days=1)) is None
