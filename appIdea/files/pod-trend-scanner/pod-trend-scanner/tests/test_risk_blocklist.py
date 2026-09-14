"""Test Lớp 1 (blocklist) — thuần, không đụng DB/mạng.

Acceptance bắt buộc trong docs/RISK_POLICY.md:
    - Bộ 20 cụm đã biết dính nhãn hiệu: bắt được >= 18
    - Bộ 20 cụm generic vô hại: false positive <= 4
"""

from pathlib import Path

import pytest

from scanner.pipeline.risk import (
    check_blocklist,
    has_probable_proper_noun,
    load_blocklist,
)

BLOCKLIST_FILE = Path(__file__).resolve().parents[1] / "data" / "blocklist.yaml"

# 20 cụm THẬT gắn với nhãn hiệu/franchise/thể thao/chính trị đã biết — mô phỏng cách
# một cụm từ POD thật sẽ chứa tên đó (không chỉ tên trần trụi).
KNOWN_TRADEMARK_PHRASES = [
    "star wars t shirt",
    "harry potter mug",
    "disney princess shirt",
    "pokemon birthday shirt",
    "hello kitty tumbler",
    "batman costume kids",
    "spider man mask",
    "minecraft creeper shirt",
    "super mario bros hat",
    "jurassic park shirt",
    "stranger things shirt",
    "winnie the pooh onesie",
    "mickey mouse ears",
    "snoopy christmas shirt",
    "nfl jersey custom",
    "nba finals shirt",
    "just do it shirt",
    "taylor swift eras tour shirt",
    "make america great again hat",
    "vote for smith 2028",
]

# 20 cụm generic thật trong niche POD (wedding/birthday/custom_photo/humor) — không
# liên quan tới bất kỳ franchise/người/nhãn hiệu nào.
GENERIC_HARMLESS_PHRASES = [
    "bridesmaid proposal box",
    "custom photo blanket",
    "personalized wedding sign",
    "funny dad shirt",
    "birthday party decorations",
    "nurse humor shirt",
    "gift for bridesmaid",
    "custom family portrait",
    "coffee mug personalized",
    "engagement announcement custom",
    "anniversary gift for wife",
    "graduation cap topper",
    "teacher appreciation gift",
    "dog mom shirt",
    "plant lady sweatshirt",
    "camping funny shirt",
    "retirement gift ideas",
    "new home ornament",
    "baby shower favors",
    "custom pet portrait",
]


@pytest.fixture(scope="module")
def blocklist():  # type: ignore[no-untyped-def]
    return load_blocklist(BLOCKLIST_FILE)


def test_known_trademark_phrases_caught_at_least_18_of_20(blocklist) -> None:  # type: ignore[no-untyped-def]
    caught = sum(1 for p in KNOWN_TRADEMARK_PHRASES if check_blocklist(p, blocklist).verdict == "block")
    assert caught >= 18, f"chỉ bắt được {caught}/20"


def test_generic_phrases_false_positive_at_most_4_of_20(blocklist) -> None:  # type: ignore[no-untyped-def]
    false_positives = [
        p for p in GENERIC_HARMLESS_PHRASES if check_blocklist(p, blocklist).verdict == "block"
    ]
    assert len(false_positives) <= 4, f"false positive: {false_positives}"


def test_blocklist_verdict_only_pass_or_block(blocklist) -> None:  # type: ignore[no-untyped-def]
    # Lớp 1 không có "review" — chỉ pass hoặc block.
    for phrase in KNOWN_TRADEMARK_PHRASES + GENERIC_HARMLESS_PHRASES:
        assert check_blocklist(phrase, blocklist).verdict in ("pass", "block")


def test_match_is_case_and_punctuation_insensitive(blocklist) -> None:  # type: ignore[no-untyped-def]
    assert check_blocklist("STAR WARS shirt", blocklist).verdict == "block"
    assert check_blocklist("star-wars shirt", blocklist).verdict == "block"
    assert check_blocklist("Star.Wars shirt", blocklist).verdict == "block"


def test_match_does_not_false_trigger_on_partial_word(blocklist) -> None:  # type: ignore[no-untyped-def]
    # "batman" không được khớp nhầm vào từ chứa "bat" hay "man" riêng lẻ.
    assert check_blocklist("man cave sign", blocklist).verdict == "pass"
    assert check_blocklist("baseball bat gift", blocklist).verdict == "pass"


def test_political_pattern_catches_new_unseen_slogans(blocklist) -> None:  # type: ignore[no-untyped-def]
    # Pattern-based nên bắt được khẩu hiệu MỚI chưa từng thấy, không chỉ danh sách cố định.
    assert check_blocklist("re-elect johnson shirt", blocklist).verdict == "block"
    assert check_blocklist("smith for governor sign", blocklist).verdict == "block"
    assert check_blocklist("make florida great again", blocklist).verdict == "block"


def test_evidence_includes_matched_category(blocklist) -> None:  # type: ignore[no-untyped-def]
    result = check_blocklist("star wars t shirt", blocklist)
    assert result.verdict == "block"
    assert any(m.category == "franchises" for m in result.matches)


def test_headline_checked_same_as_term(blocklist) -> None:  # type: ignore[no-untyped-def]
    # rule: chạy trên cả term và headline LLM sinh ra — check_blocklist() nhận text bất kỳ.
    headline = "The Ultimate Batman Fan Gift For Every Occasion"
    assert check_blocklist(headline, blocklist).verdict == "block"


def test_has_probable_proper_noun_detects_capitalized_mid_phrase() -> None:
    assert has_probable_proper_noun("Best Friend Gift For Sarah") is True
    assert has_probable_proper_noun("bridesmaid proposal box") is False


def test_has_probable_proper_noun_ignores_sentence_initial_capital() -> None:
    assert has_probable_proper_noun("Bridesmaid proposal box") is False
