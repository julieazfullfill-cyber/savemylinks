"""Pydantic schema cho `design_brief` — khớp docs/DESIGN_BRIEF_SPEC.md mục 2.

LLM (pipeline/brief.py) chỉ ĐIỀN brief này, không viết prompt. Renderer (render.py)
là code thuần ghép brief thành prompt — validate bằng model này TRƯỚC khi ghi DB
(CLAUDE.md rule 10: mọi output LLM validate bằng Pydantic trước khi ghi DB)."""

from typing import Literal

from pydantic import BaseModel, Field

RiskLevel = Literal["low", "review", "blocked"]
OriginClassification = Literal["generic", "derived_from_media", "proper_noun", "unknown"]
CheckVerdict = Literal["pass", "review", "block"]


class SourceEvidence(BaseModel):
    velocity_7d: float | None = None
    sources: list[str] = Field(default_factory=list)
    saturation: int | None = None


class Source(BaseModel):
    term: str
    niche: str
    risk_tier: Literal["T0", "T1", "T2", "T3"]
    evidence: SourceEvidence = Field(default_factory=SourceEvidence)


class Product(BaseModel):
    type: str
    print_area: str
    canvas_px: tuple[int, int]
    print_method: str
    max_colors: int | None = None


class Concept(BaseModel):
    buyer: str
    recipient: str | None = None
    occasion: str
    emotional_angle: Literal["sentimental", "sarcastic", "celebratory", "proud", "wholesome"]
    why_it_sells: str


class PersonalizationSlot(BaseModel):
    name: str
    placeholder: str
    max_chars: int
    case: Literal["upper", "title", "lower"]


class Typography(BaseModel):
    primary_style: str
    case: Literal["upper", "title", "lower"]
    arrangement: str
    emphasis_word: str | None = None


class TextLayer(BaseModel):
    enabled: bool
    headline: str | None = None
    subline: str | None = None
    personalization_slots: list[PersonalizationSlot] = Field(default_factory=list)
    typography: Typography | None = None


class Palette(BaseModel):
    mode: Literal["limited", "full"]
    colors: list[str] = Field(default_factory=list)
    background: str = "transparent"


class ArtLayer(BaseModel):
    enabled: bool
    subject: str | None = None
    style: str | None = None
    composition: str | None = None
    palette: Palette | None = None
    detail_level: Literal["minimal", "moderate", "detailed"] | None = None
    texture: str | None = None


class Layout(BaseModel):
    text_anchor: Literal[
        "above_art", "below_art", "overlay_center", "art_only", "text_only"
    ]
    safe_margin_pct: int = 8


class Listing(BaseModel):
    title: str = Field(max_length=140)
    tags: list[str] = Field(default_factory=list)
    bullets: list[str] = Field(default_factory=list)


class RiskChecks(BaseModel):
    blocklist: CheckVerdict | None = None
    uspto_class25: CheckVerdict | None = None
    llm_origin: CheckVerdict | None = None


class RiskInfo(BaseModel):
    level: RiskLevel
    origin_classification: OriginClassification
    checks: RiskChecks = Field(default_factory=RiskChecks)
    human_approved_by: str | None = None


class DesignBrief(BaseModel):
    """LLM chỉ trả về từ `source` tới `risk` (không có brief_id/created_at — hai
    trường đó do brief.py tự sinh, không để LLM bịa)."""

    source: Source
    product: Product
    concept: Concept
    text_layer: TextLayer
    art_layer: ArtLayer
    layout: Layout
    constraints: list[str] = Field(default_factory=list)
    negative: list[str] = Field(default_factory=list)
    listing: Listing
    risk: RiskInfo
