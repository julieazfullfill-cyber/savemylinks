from pathlib import Path

import pytest

from scanner.core.seeds import CORE_NICHES, SeedRow, parse_seed_file


@pytest.fixture(scope="module")
def rows(seed_file: Path) -> list[SeedRow]:
    return parse_seed_file(seed_file)


def test_loads_209_seeds(rows: list[SeedRow]) -> None:
    assert len(rows) == 209


def test_core_and_expansion_split(rows: list[SeedRow]) -> None:
    core = [r for r in rows if r.is_core]
    assert len(core) == 150
    assert len(rows) - len(core) == 59
    assert {r.niche for r in core} == set(CORE_NICHES)


def test_every_row_has_valid_tier_and_niche(rows: list[SeedRow]) -> None:
    for row in rows:
        assert row.risk_tier in {"T0", "T1", "T2", "T3"}
        assert row.niche
        assert row.seed.strip() == row.seed and row.seed


def test_expansion_tiers_match_group_risk(rows: list[SeedRow]) -> None:
    tiers = {r.niche: r.risk_tier for r in rows if not r.is_core}
    assert tiers["occupation_humor"] == "T1"
    assert tiers["hobby_humor"] == "T1"
    assert tiers["general_humor"] == "T1"
    assert tiers["pop_culture"] == "T2"
    assert tiers["political_civic"] == "T3"


def test_core_metadata_is_preserved(rows: list[SeedRow]) -> None:
    by_seed = {r.seed: r for r in rows}
    row = by_seed["bridesmaid proposal box"]
    assert row.niche == "wedding"
    assert row.sub_niche == "bridal_party"
    assert row.risk_tier == "T0"
    assert row.personalized is True
    assert row.intent == "gift"
    assert row.peak_months == (1, 2, 3, 4)


def test_no_duplicate_seed_niche_pairs(rows: list[SeedRow]) -> None:
    pairs = [(r.seed.lower(), r.niche) for r in rows]
    assert len(pairs) == len(set(pairs))
