"""household_deletion: a scheduled, cancellable household delete (ADR-0017 §4).

households gains deletion_requested_at, deletion_requested_by and delete_after, all nullable:
expand-only, the running app keeps working until the new code ships. No new table, so no new
policy: households already has FORCE RLS keyed on its own id.

Revision ID: 0007_household_deletion
Revises: 0006_household_consents
Create Date: 2026-10-19 13:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_household_deletion"
down_revision: str | None = "0006_household_consents"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "households",
        sa.Column("deletion_requested_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("households", sa.Column("deletion_requested_by", sa.UUID(), nullable=True))
    op.add_column(
        "households", sa.Column("delete_after", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("households", "delete_after")
    op.drop_column("households", "deletion_requested_by")
    op.drop_column("households", "deletion_requested_at")
