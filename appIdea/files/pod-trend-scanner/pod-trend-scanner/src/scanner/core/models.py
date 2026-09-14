"""SQLAlchemy models — khớp docs/DATA_MODEL.md.

raw_items và term_observations là event log bất biến: chỉ INSERT.
"""

from datetime import date as date_t
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


TZ = DateTime(timezone=True)

RISK_TIERS = ("T0", "T1", "T2", "T3")


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    config: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    created_at: Mapped[datetime] = mapped_column(TZ, nullable=False, server_default=func.now())


class Seed(Base):
    __tablename__ = "seeds"
    __table_args__ = (
        UniqueConstraint("seed", "niche"),
        CheckConstraint(
            "risk_tier IN ('T0', 'T1', 'T2', 'T3')", name="seeds_risk_tier_check"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    seed: Mapped[str] = mapped_column(Text, nullable=False)
    niche: Mapped[str] = mapped_column(Text, nullable=False)
    sub_niche: Mapped[str | None] = mapped_column(Text)
    risk_tier: Mapped[str] = mapped_column(Text, nullable=False)
    personalized: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    intent: Mapped[str | None] = mapped_column(Text)
    peak_months: Mapped[list[int]] = mapped_column(
        ARRAY(SmallInteger), nullable=False, server_default="{}"
    )
    note: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")


class RawItem(Base):
    """Bất biến. Chỉ INSERT, không UPDATE, không DELETE."""

    __tablename__ = "raw_items"
    __table_args__ = (UniqueConstraint("source_id", "external_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id"), nullable=False)
    external_id: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(TZ, nullable=False, server_default=func.now())


class Term(Base):
    __tablename__ = "terms"
    __table_args__ = (
        Index("ix_terms_text_key", "text_key"),
        Index("ix_terms_first_seen_at", "first_seen_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    text_norm: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    text_key: Mapped[str] = mapped_column(Text, nullable=False)
    text_display: Mapped[str] = mapped_column(Text, nullable=False)
    # display_rank: rank tốt nhất từng thấy của text_display hiện tại.
    display_rank: Mapped[int | None] = mapped_column(SmallInteger)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="keyword")
    niche: Mapped[str | None] = mapped_column(Text)
    first_seen_at: Mapped[datetime] = mapped_column(TZ, nullable=False, server_default=func.now())


class TermObservation(Base):
    """Bất biến. Chỉ INSERT."""

    __tablename__ = "term_observations"
    __table_args__ = (
        Index("ix_term_observations_term_observed", "term_id", "observed_at"),
        Index("ix_term_observations_source_observed", "source_id", "observed_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    term_id: Mapped[int] = mapped_column(ForeignKey("terms.id"), nullable=False)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id"), nullable=False)
    seed_id: Mapped[int | None] = mapped_column(ForeignKey("seeds.id"))
    observed_at: Mapped[datetime] = mapped_column(TZ, nullable=False)
    rank: Mapped[int | None] = mapped_column(SmallInteger)
    value: Mapped[Decimal | None] = mapped_column(Numeric)
    raw_item_id: Mapped[int] = mapped_column(ForeignKey("raw_items.id"), nullable=False)


class TermMetricsDaily(Base):
    __tablename__ = "term_metrics_daily"

    term_id: Mapped[int] = mapped_column(ForeignKey("terms.id"), primary_key=True)
    date: Mapped[date_t] = mapped_column(Date, primary_key=True)
    value_norm: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    velocity_7d: Mapped[Decimal | None] = mapped_column(Numeric)
    velocity_21d: Mapped[Decimal | None] = mapped_column(Numeric)
    accel: Mapped[Decimal | None] = mapped_column(Numeric)
    n_sources: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")


class TermEnrichment(Base):
    __tablename__ = "term_enrichment"

    term_id: Mapped[int] = mapped_column(ForeignKey("terms.id"), primary_key=True)
    competing_listings: Mapped[int | None] = mapped_column(Integer)
    saturation_score: Mapped[Decimal | None] = mapped_column(Numeric)
    commercial_signal: Mapped[bool | None] = mapped_column(Boolean, server_default="false")
    checked_at: Mapped[datetime | None] = mapped_column(TZ)


class Occasion(Base):
    __tablename__ = "occasions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    peak_months: Mapped[list[int]] = mapped_column(ARRAY(SmallInteger), nullable=False)
    lead_weeks: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    niches: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)


class UsptoTrademark(Base):
    """Index nội bộ dựng từ bulk data XML USPTO ("Trademark Applications Daily"),
    xem pipeline/uspto_index.py. Thay cho live API (cần tài khoản USPTO.gov + MFA,
    không khả dụng — xem docs/RISK_POLICY.md phần Lớp 2)."""

    __tablename__ = "uspto_trademarks"
    __table_args__ = (
        Index("ix_uspto_trademarks_mark_norm", "mark_norm"),
        Index(
            "ix_uspto_trademarks_us_classes", "us_classes", postgresql_using="gin"
        ),
        Index(
            "ix_uspto_trademarks_intl_classes", "intl_classes", postgresql_using="gin"
        ),
    )

    serial_number: Mapped[str] = mapped_column(Text, primary_key=True)
    registration_number: Mapped[str | None] = mapped_column(Text)
    mark_identification: Mapped[str | None] = mapped_column(Text)
    mark_norm: Mapped[str] = mapped_column(Text, nullable=False)
    status_code: Mapped[str] = mapped_column(Text, nullable=False)
    status_category: Mapped[str] = mapped_column(Text, nullable=False)  # live|dead|unknown
    status_date: Mapped[date_t | None] = mapped_column(Date)
    filing_date: Mapped[date_t | None] = mapped_column(Date)
    registration_date: Mapped[date_t | None] = mapped_column(Date)
    us_classes: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, server_default="{}")
    intl_classes: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, server_default="{}")
    source_file: Mapped[str] = mapped_column(Text, nullable=False)
    loaded_at: Mapped[datetime] = mapped_column(TZ, nullable=False, server_default=func.now())


class UsptoBulkFile(Base):
    """Manifest các file bulk XML đã nạp — dùng để biết index đang phủ tới đâu (xem
    settings.uspto_index_coverage_complete, pipeline/risk.py)."""

    __tablename__ = "uspto_bulk_files"

    filename: Mapped[str] = mapped_column(Text, primary_key=True)
    record_count: Mapped[int] = mapped_column(Integer, nullable=False)
    loaded_at: Mapped[datetime] = mapped_column(TZ, nullable=False, server_default=func.now())


class RiskFlag(Base):
    __tablename__ = "risk_flags"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    term_id: Mapped[int | None] = mapped_column(ForeignKey("terms.id"))
    candidate_id: Mapped[int | None] = mapped_column(BigInteger)
    layer: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TZ, nullable=False, server_default=func.now())


class Candidate(Base):
    __tablename__ = "candidates"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    term_id: Mapped[int] = mapped_column(ForeignKey("terms.id"), nullable=False)
    momentum: Mapped[Decimal | None] = mapped_column(Numeric)
    opportunity: Mapped[Decimal | None] = mapped_column(Numeric)
    risk_level: Mapped[str] = mapped_column(Text, nullable=False, server_default="unknown")
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    approved_by: Mapped[str | None] = mapped_column(Text)
    approved_at: Mapped[datetime | None] = mapped_column(TZ)
    created_at: Mapped[datetime] = mapped_column(TZ, nullable=False, server_default=func.now())


class DesignBrief(Base):
    __tablename__ = "design_briefs"
    __table_args__ = (Index("ix_design_briefs_payload", "payload", postgresql_using="gin"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id"), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    image_prompt: Mapped[str | None] = mapped_column(Text)
    exported_at: Mapped[datetime | None] = mapped_column(TZ)
    created_at: Mapped[datetime] = mapped_column(TZ, nullable=False, server_default=func.now())


__all__ = [
    "RISK_TIERS",
    "Base",
    "Candidate",
    "DesignBrief",
    "Occasion",
    "RawItem",
    "RiskFlag",
    "Seed",
    "Source",
    "Term",
    "TermEnrichment",
    "TermMetricsDaily",
    "TermObservation",
    "UsptoBulkFile",
    "UsptoTrademark",
]
