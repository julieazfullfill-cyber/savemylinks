"""Test thuần cho công thức velocity — không đụng DB."""

import pytest

from scanner.pipeline.metrics import compute_velocity, linear_slope


def test_slope_of_perfect_linear_sequence_matches_step() -> None:
    values = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0]
    assert linear_slope(values) == pytest.approx(10.0)


def test_slope_of_flat_sequence_is_zero() -> None:
    assert linear_slope([50.0] * 10) == pytest.approx(0.0)


def test_slope_of_declining_sequence_is_negative() -> None:
    values = [100.0, 90.0, 80.0, 70.0]
    assert linear_slope(values) == pytest.approx(-10.0)


def test_slope_needs_at_least_two_points() -> None:
    assert linear_slope([]) is None
    assert linear_slope([42.0]) is None


def test_slope_of_single_repeated_point_pair_is_defined() -> None:
    assert linear_slope([5.0, 5.0]) == pytest.approx(0.0)


def test_compute_velocity_uses_last_7_and_last_21_points() -> None:
    # 21 điểm tăng tuyến tính đều đặn slope=5, cả v7 lẫn v21 phải bằng slope thật.
    history = [5.0 * i for i in range(21)]
    v7, v21, accel = compute_velocity(history)
    assert v7 == pytest.approx(5.0)
    assert v21 == pytest.approx(5.0)
    assert accel == pytest.approx(0.0)


def test_compute_velocity_detects_acceleration() -> None:
    # 21 điểm phẳng, rồi 7 điểm cuối tăng vọt -> v7 > v21 > 0, accel dương.
    flat = [20.0] * 14
    rising = [20.0 + 10.0 * i for i in range(7)]
    history = flat + rising
    v7, v21, accel = compute_velocity(history)
    assert v7 is not None and v21 is not None and accel is not None
    assert v7 > v21
    assert accel > 0


def test_compute_velocity_with_fewer_than_7_points() -> None:
    v7, v21, accel = compute_velocity([1.0, 2.0, 3.0])
    assert v7 == pytest.approx(1.0)
    assert v21 == pytest.approx(1.0)
    assert accel == pytest.approx(0.0)


def test_compute_velocity_with_single_point_is_all_none() -> None:
    assert compute_velocity([42.0]) == (None, None, None)


def test_compute_velocity_with_empty_history_is_all_none() -> None:
    assert compute_velocity([]) == (None, None, None)
