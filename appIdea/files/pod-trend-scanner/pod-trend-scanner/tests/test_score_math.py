"""Test thuần cho công thức momentum/opportunity — không đụng DB."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from scanner.pipeline.score import (
    compute_momentum,
    compute_opportunity,
    norm_accel,
    norm_n_sources,
    recency,
)


def test_norm_accel_zero_is_midpoint() -> None:
    assert norm_accel(0.0) == pytest.approx(0.5)


def test_norm_accel_monotonic_and_bounded() -> None:
    low = norm_accel(-50.0)
    mid = norm_accel(0.0)
    high = norm_accel(50.0)
    assert 0.0 < low < mid < high < 1.0


def test_norm_n_sources_scales_linearly_and_caps_at_one() -> None:
    assert norm_n_sources(1, max_sources=5) == pytest.approx(0.2)
    assert norm_n_sources(5, max_sources=5) == pytest.approx(1.0)
    assert norm_n_sources(99, max_sources=5) == 1.0  # không vượt 1 dù n_sources lớn hơn max


def test_norm_n_sources_zero_max_is_zero() -> None:
    assert norm_n_sources(3, max_sources=0) == 0.0


def test_recency_is_one_at_zero_days() -> None:
    now = datetime(2026, 9, 14, tzinfo=UTC)
    assert recency(now, now) == pytest.approx(1.0)


def test_recency_halves_at_half_life() -> None:
    now = datetime(2026, 9, 14, tzinfo=UTC)
    thirty_days_ago = now - timedelta(days=30)
    assert recency(thirty_days_ago, now) == pytest.approx(0.5, abs=0.01)


def test_recency_never_reaches_zero() -> None:
    now = datetime(2026, 9, 14, tzinfo=UTC)
    long_ago = now - timedelta(days=3650)
    assert recency(long_ago, now) > 0.0


def test_recency_future_first_seen_clamped_to_one() -> None:
    now = datetime(2026, 9, 14, tzinfo=UTC)
    future = now + timedelta(days=10)
    assert recency(future, now) == pytest.approx(1.0)


def test_compute_momentum_stays_in_0_1_range() -> None:
    now = datetime(2026, 9, 14, tzinfo=UTC)
    m = compute_momentum(accel=20.0, n_sources=5, first_seen_at=now, max_sources=5, as_of=now)
    assert Decimal("0") <= m <= Decimal("1")


def test_compute_opportunity_none_when_not_enriched() -> None:
    assert compute_opportunity(saturation_score=None, commercial_signal=True) is None


def test_compute_opportunity_high_saturation_pushes_score_down() -> None:
    low_sat = compute_opportunity(saturation_score=Decimal("0.1"), commercial_signal=True)
    high_sat = compute_opportunity(saturation_score=Decimal("0.95"), commercial_signal=True)
    assert low_sat is not None and high_sat is not None
    assert high_sat < low_sat


def test_compute_opportunity_commercial_signal_adds_weight() -> None:
    with_signal = compute_opportunity(saturation_score=Decimal("0.5"), commercial_signal=True)
    without_signal = compute_opportunity(saturation_score=Decimal("0.5"), commercial_signal=False)
    assert with_signal is not None and without_signal is not None
    assert with_signal > without_signal
