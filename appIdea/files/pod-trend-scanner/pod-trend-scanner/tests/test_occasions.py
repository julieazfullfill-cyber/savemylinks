from pathlib import Path

import pytest

from scanner.core.occasions import OccasionRow, parse_occasion_file

OCCASIONS_FILE = Path(__file__).resolve().parents[1] / "data" / "occasions.json"


@pytest.fixture(scope="module")
def rows() -> list[OccasionRow]:
    return parse_occasion_file(OCCASIONS_FILE)


def test_loads_all_occasions(rows: list[OccasionRow]) -> None:
    assert len(rows) == 10


def test_wedding_season_matches_acceptance_example(rows: list[OccasionRow]) -> None:
    by_name = {r.name: r for r in rows}
    wedding = by_name["wedding_season_us"]
    assert wedding.peak_months == (5, 6, 7, 8)
    assert 8 <= wedding.lead_weeks <= 12
    assert "wedding" in wedding.niches


def test_every_occasion_has_valid_fields(rows: list[OccasionRow]) -> None:
    for row in rows:
        assert row.name
        assert row.peak_months
        assert all(1 <= m <= 12 for m in row.peak_months)
        assert row.lead_weeks > 0
        assert row.niches


def test_names_are_unique(rows: list[OccasionRow]) -> None:
    names = [r.name for r in rows]
    assert len(names) == len(set(names))


def test_rejects_invalid_peak_month() -> None:
    import json
    import tempfile

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as f:
        json.dump(
            {"occasions": [{"name": "bad", "peak_months": [13], "lead_weeks": 8, "niches": ["x"]}]},
            f,
        )
        path = f.name
    with pytest.raises(ValueError, match="ngoài khoảng"):
        parse_occasion_file(path)


def test_rejects_duplicate_names() -> None:
    import json
    import tempfile

    payload = {
        "occasions": [
            {"name": "dup", "peak_months": [1], "lead_weeks": 4, "niches": ["a"]},
            {"name": "dup", "peak_months": [2], "lead_weeks": 4, "niches": ["b"]},
        ]
    }
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as f:
        json.dump(payload, f)
        path = f.name
    with pytest.raises(ValueError, match="trùng tên"):
        parse_occasion_file(path)
