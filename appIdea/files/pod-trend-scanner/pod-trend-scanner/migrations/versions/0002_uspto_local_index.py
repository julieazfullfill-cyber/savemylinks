"""uspto local trademark index

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "uspto_trademarks",
        sa.Column("serial_number", sa.Text(), primary_key=True),
        sa.Column("registration_number", sa.Text()),
        sa.Column("mark_identification", sa.Text()),
        sa.Column("mark_norm", sa.Text(), nullable=False),
        sa.Column("status_code", sa.Text(), nullable=False),
        sa.Column("status_category", sa.Text(), nullable=False),
        sa.Column("status_date", sa.Date()),
        sa.Column("filing_date", sa.Date()),
        sa.Column("registration_date", sa.Date()),
        sa.Column(
            "us_classes",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
        sa.Column(
            "intl_classes",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
        sa.Column("source_file", sa.Text(), nullable=False),
        sa.Column("loaded_at", TZ, nullable=False, server_default=sa.text("now()")),
    )
    op.create_index(
        "ix_uspto_trademarks_mark_norm", "uspto_trademarks", ["mark_norm"]
    )
    op.create_index(
        "ix_uspto_trademarks_us_classes",
        "uspto_trademarks",
        ["us_classes"],
        postgresql_using="gin",
    )
    op.create_index(
        "ix_uspto_trademarks_intl_classes",
        "uspto_trademarks",
        ["intl_classes"],
        postgresql_using="gin",
    )

    op.create_table(
        "uspto_bulk_files",
        sa.Column("filename", sa.Text(), primary_key=True),
        sa.Column("record_count", sa.Integer(), nullable=False),
        sa.Column("loaded_at", TZ, nullable=False, server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_table("uspto_bulk_files")
    op.drop_table("uspto_trademarks")
