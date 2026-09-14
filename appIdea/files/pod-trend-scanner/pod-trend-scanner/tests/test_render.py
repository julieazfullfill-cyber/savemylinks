"""Test renderer — offline, thuần code, không mạng. 3 ví dụ transcribe nguyên văn từ
docs/DESIGN_BRIEF_SPEC.md mục 5 (wedding T0, birthday T1, funny tee typography-only T1).
Ví dụ 5.2/5.3 trong spec không in đủ khối `listing` (rút gọn cho ngắn tài liệu) — tự
điền giá trị hợp lý ở đây, không đổi ý nghĩa phần đang test (art_layer/text_layer)."""

import pytest
from pydantic import ValidationError

from scanner.pipeline.design_brief_schema import DesignBrief
from scanner.pipeline.render import render

WEDDING_BRIEF = {
    "source": {"term": "bridesmaid proposal box", "niche": "wedding", "risk_tier": "T0"},
    "product": {
        "type": "tshirt",
        "print_area": "front_center",
        "canvas_px": [4500, 5400],
        "print_method": "dtg",
        "max_colors": 4,
    },
    "concept": {
        "buyer": "Cô dâu 27-34 đang chuẩn bị đám cưới mùa hè, mua 4-6 cái cùng lúc cho nhóm phù dâu",
        "recipient": "Bạn thân được mời làm phù dâu",
        "occasion": "Bridesmaid proposal, 4-8 tháng trước ngày cưới",
        "emotional_angle": "sentimental",
        "why_it_sells": "Đây là khoảnh khắc được chụp ảnh và đăng lên mạng",
    },
    "text_layer": {
        "enabled": True,
        "headline": "WILL YOU BE MY BRIDESMAID",
        "subline": "{NAME}",
        "personalization_slots": [
            {"name": "bridesmaid_name", "placeholder": "{NAME}", "max_chars": 14, "case": "title"}
        ],
        "typography": {
            "primary_style": "flowing script for subline, clean serif for headline",
            "case": "upper",
            "arrangement": "stacked",
            "emphasis_word": "BRIDESMAID",
        },
    },
    "art_layer": {
        "enabled": True,
        "subject": "delicate eucalyptus and baby's breath sprig arrangement, half-wreath opening upward",
        "style": "fine line botanical illustration",
        "composition": "wreath around text",
        "palette": {"mode": "limited", "colors": ["#7A8B6F", "#C4A582"], "background": "transparent"},
        "detail_level": "moderate",
        "texture": "clean",
    },
    "layout": {"text_anchor": "overlay_center", "safe_margin_pct": 8},
    "listing": {
        "title": "Will You Be My Bridesmaid Shirt Personalized Name Proposal Gift",
        "tags": ["bridesmaid proposal", "will you be my bridesmaid"],
    },
    "risk": {"level": "low", "origin_classification": "generic"},
}

# Chuỗi prompt "đúng" in nguyên văn ở spec mục 5.1, sau đoạn "Prompt ảnh renderer sinh ra:".
WEDDING_EXPECTED_PROMPT = (
    "fine line botanical illustration of delicate eucalyptus and baby's breath sprig "
    "arrangement, half-wreath opening upward, wreath around text composition, moderate "
    "detail, clean finish, color palette #7A8B6F, #C4A582, isolated on pure transparent "
    "background, flat 2D artwork for apparel screen print, centered, even margins, no "
    "perspective, no shadow"
)

BIRTHDAY_BRIEF = {
    "source": {"term": "50th birthday shirt funny", "niche": "birthday", "risk_tier": "T1"},
    "product": {
        "type": "tshirt",
        "print_area": "front_center",
        "canvas_px": [4500, 5400],
        "print_method": "dtg",
        "max_colors": 3,
    },
    "concept": {
        "buyer": "Con gái 25-40 mua quà cho bố/mẹ tròn 50",
        "occasion": "Tiệc sinh nhật mốc 50",
        "emotional_angle": "sarcastic",
        "why_it_sells": "Người mua cần một món quà gây cười ngay lúc mở",
    },
    "text_layer": {
        "enabled": True,
        "headline": "LEVEL 50 UNLOCKED",
        "subline": "EST. {YEAR}",
        "personalization_slots": [
            {"name": "birth_year", "placeholder": "{YEAR}", "max_chars": 4, "case": "upper"}
        ],
        "typography": {
            "primary_style": "bold condensed sans",
            "case": "upper",
            "arrangement": "mixed_weight_stack",
            "emphasis_word": "50",
        },
    },
    "art_layer": {
        "enabled": True,
        "subject": "retro sunburst rays radiating from behind center, simple starburst accents",
        "style": "retro 70s groovy",
        "composition": "badge circle",
        "palette": {
            "mode": "limited",
            "colors": ["#D96C3F", "#E8C547", "#2B4162"],
            "background": "transparent",
        },
        "detail_level": "minimal",
        "texture": "subtle grain",
    },
    "layout": {"text_anchor": "overlay_center", "safe_margin_pct": 10},
    "listing": {"title": "Level 50 Unlocked Funny 50th Birthday Shirt", "tags": ["50th birthday"]},
    "risk": {"level": "low", "origin_classification": "generic"},
}

NURSE_BRIEF = {
    "source": {"term": "nurse humor shirt", "niche": "occupation_humor", "risk_tier": "T1"},
    "product": {
        "type": "tshirt",
        "print_area": "front_center",
        "canvas_px": [4500, 5400],
        "print_method": "dtg",
        "max_colors": 2,
    },
    "concept": {
        "buyer": "Điều dưỡng nữ 24-45, tự mua để mặc ngày off hoặc mua tặng đồng nghiệp",
        "occasion": "Nurses Week tháng 5, hoặc mua tuỳ hứng quanh năm",
        "emotional_angle": "sarcastic",
        "why_it_sells": "Câu đùa chỉ người trong nghề mới hiểu",
    },
    "text_layer": {
        "enabled": True,
        "headline": "RUNS ON CAFFEINE AND TWELVE HOUR SHIFTS",
        "personalization_slots": [],
        "typography": {
            "primary_style": "bold condensed sans",
            "case": "upper",
            "arrangement": "stacked",
            "emphasis_word": "TWELVE HOUR",
        },
    },
    "art_layer": {"enabled": False},
    "layout": {"text_anchor": "text_only", "safe_margin_pct": 10},
    "listing": {"title": "Nurse Humor Shirt Runs On Caffeine", "tags": ["nurse shirt"]},
    "risk": {
        "level": "low",
        "origin_classification": "generic",
        "checks": {"blocklist": "pass", "uspto_class25": "pass", "llm_origin": "pass"},
    },
}


def test_wedding_brief_validates_against_schema() -> None:
    DesignBrief.model_validate(WEDDING_BRIEF)


def test_wedding_brief_renders_prompt_matching_spec_example_exactly() -> None:
    brief = DesignBrief.model_validate(WEDDING_BRIEF)
    result = render(brief)
    assert result is not None
    assert result.prompt == WEDDING_EXPECTED_PROMPT


def test_wedding_brief_upscale_and_dimensions_match_canvas_ratio() -> None:
    brief = DesignBrief.model_validate(WEDDING_BRIEF)
    result = render(brief)
    assert result is not None
    assert result.width == 1024
    assert result.height == 1229  # round(1024 * 5400 / 4500)
    assert result.upscale_to == (4500, 5400)


def test_wedding_brief_negative_prompt_includes_hard_negative() -> None:
    brief = DesignBrief.model_validate(WEDDING_BRIEF)
    result = render(brief)
    assert result is not None
    assert "text" in result.negative_prompt
    assert "photorealistic" in result.negative_prompt


def test_wedding_brief_gets_tshirt_front_center_constraints() -> None:
    brief = DesignBrief.model_validate(WEDDING_BRIEF)
    result = render(brief)
    assert result is not None
    assert any("nền trong suốt" in c for c in result.constraints)


def test_birthday_brief_validates_and_renders_something() -> None:
    brief = DesignBrief.model_validate(BIRTHDAY_BRIEF)
    result = render(brief)
    assert result is not None
    assert "retro 70s groovy of retro sunburst rays" in result.prompt


def test_nurse_typography_only_brief_validates() -> None:
    DesignBrief.model_validate(NURSE_BRIEF)


def test_nurse_typography_only_returns_none_no_image_model_called() -> None:
    # Acceptance (DESIGN_BRIEF_SPEC.md mục 5.3): typography-only bỏ qua hẳn model ảnh.
    brief = DesignBrief.model_validate(NURSE_BRIEF)
    assert render(brief) is None


def test_art_enabled_but_missing_required_fields_raises_not_silently_skips() -> None:
    broken = dict(WEDDING_BRIEF)
    broken["art_layer"] = {"enabled": True}  # thiếu subject/style/composition/palette
    brief = DesignBrief.model_validate(broken)
    with pytest.raises(ValueError):
        render(brief)


def test_schema_rejects_invalid_emotional_angle() -> None:
    bad = dict(WEDDING_BRIEF)
    bad["concept"] = dict(WEDDING_BRIEF["concept"])
    bad["concept"]["emotional_angle"] = "angry"  # không nằm trong enum spec
    with pytest.raises(ValidationError):
        DesignBrief.model_validate(bad)


def test_schema_rejects_listing_title_over_140_chars() -> None:
    bad = dict(WEDDING_BRIEF)
    bad["listing"] = {"title": "x" * 141}
    with pytest.raises(ValidationError):
        DesignBrief.model_validate(bad)
