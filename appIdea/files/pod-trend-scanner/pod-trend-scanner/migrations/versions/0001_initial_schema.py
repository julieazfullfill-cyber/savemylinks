"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-09-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "sources",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False, unique=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "config", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.text("now()")),
    )

    op.create_table(
        "seeds",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("seed", sa.Text(), nullable=False),
        sa.Column("niche", sa.Text(), nullable=False),
        sa.Column("sub_niche", sa.Text()),
        sa.Column("risk_tier", sa.Text(), nullable=False),
        sa.Column("personalized", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("intent", sa.Text()),
        sa.Column(
            "peak_months",
            postgresql.ARRAY(sa.SmallInteger()),
            nullable=False,
            server_default=sa.text("'{}'::smallint[]"),
        ),
        sa.Column("note", sa.Text()),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.CheckConstraint("risk_tier IN ('T0', 'T1', 'T2', 'T3')", name="seeds_risk_tier_check"),
        sa.UniqueConstraint("seed", "niche", name="uq_seeds_seed_niche"),
    )

    op.create_table(
        "raw_items",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("source_id", sa.Integer(), sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("external_id", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("fetched_at", TZ, nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("source_id", "external_id", name="uq_raw_items_source_external"),
    )

    op.create_table(
        "terms",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("text_norm", sa.Text(), nullable=False, unique=True),
        sa.Column("text_key", sa.Text(), nullable=False),
        sa.Column("text_display", sa.Text(), nullable=False),
        sa.Column("display_rank", sa.SmallInteger()),
        sa.Column("kind", sa.Text(), nullable=False, server_default=sa.text("'keyword'")),
        sa.Column("niche", sa.Text()),
        sa.Column("first_seen_at", TZ, nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_terms_text_key", "terms", ["text_key"])
    op.create_index("ix_terms_first_seen_at", "terms", ["first_seen_at"])

    op.create_table(
        "term_observations",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("term_id", sa.BigInteger(), sa.ForeignKey("terms.id"), nullable=False),
        sa.Column("source_id", sa.Integer(), sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("seed_id", sa.Integer(), sa.ForeignKey("seeds.id")),
        sa.Column("observed_at", TZ, nullable=False),
        sa.Column("rank", sa.SmallInteger()),
        sa.Column("value", sa.Numeric()),
        sa.Column("raw_item_id", sa.BigInteger(), sa.ForeignKey("raw_items.id"), nullable=False),
    )
    op.create_index(
        "ix_term_observations_term_observed", "term_observations", ["term_id", "observed_at"]
    )
    op.create_index(
        "ix_term_observations_source_observed", "term_observations", ["source_id", "observed_at"]
    )

    op.create_table(
        "term_metrics_daily",
        sa.Column("term_id", sa.BigInteger(), sa.ForeignKey("terms.id"), primary_key=True),
        sa.Column("date", sa.Date(), primary_key=True),
        sa.Column("value_norm", sa.Numeric(), nullable=False),
        sa.Column("velocity_7d", sa.Numeric()),
        sa.Column("velocity_21d", sa.Numeric()),
        sa.Column("accel", sa.Numeric()),
        sa.Column("n_sources", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
    )

    op.create_table(
        "term_enrichment",
        sa.Column("term_id", sa.BigInteger(), sa.ForeignKey("terms.id"), primary_key=True),
        sa.Column("competing_listings", sa.Integer()),
        sa.Column("saturation_score", sa.Numeric()),
        sa.Column("commercial_signal", sa.Boolean(), server_default=sa.text("false")),
        sa.Column("checked_at", TZ),
    )

    op.create_table(
        "occasions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False, unique=True),
        sa.Column("peak_months", postgresql.ARRAY(sa.SmallInteger()), nullable=False),
        sa.Column("lead_weeks", sa.SmallInteger(), nullable=False),
        sa.Column("niches", postgresql.ARRAY(sa.Text()), nullable=False),
    )

    op.create_table(
        "risk_flags",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("term_id", sa.BigInteger(), sa.ForeignKey("terms.id")),
        sa.Column("candidate_id", sa.BigInteger()),
        sa.Column("layer", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=False),
        sa.Column("evidence", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.text("now()")),
    )

    op.create_table(
        "candidates",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("term_id", sa.BigInteger(), sa.ForeignKey("terms.id"), nullable=False),
        sa.Column("momentum", sa.Numeric()),
        sa.Column("opportunity", sa.Numeric()),
        sa.Column("risk_level", sa.Text(), nullable=False, server_default=sa.text("'unknown'")),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("approved_by", sa.Text()),
        sa.Column("approved_at", TZ),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.text("now()")),
    )

    op.create_table(
        "design_briefs",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("candidate_id", sa.BigInteger(), sa.ForeignKey("candidates.id"), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("image_prompt", sa.Text()),
        sa.Column("exported_at", TZ),
        sa.Column("created_at", TZ, nullable=False, server_default=sa.text("now()")),
    )
    op.create_index(
        "ix_design_briefs_payload", "design_briefs", ["payload"], postgresql_using="gin"
    )


def downgrade() -> None:
    op.drop_table("design_briefs")
    op.drop_table("candidates")
    op.drop_table("risk_flags")
    op.drop_table("occasions")
    op.drop_table("term_enrichment")
    op.drop_table("term_metrics_daily")
    op.drop_table("term_observations")
    op.drop_table("terms")
    op.drop_table("raw_items")
    op.drop_table("seeds")
    op.drop_table("sources")
