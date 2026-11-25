"""jar_cycle: the Gratitude Jar's auto-cycle state (ADR-0018 amendment, part B).

Two nullable columns on `games`: `cycle_anchor_at` (when the cycle was last started or
re-anchored) and `cycle_paused_index` (the note being held while paused). Null for every
non-jar game and every manual jar. No new table, so no new RLS policy.

Revision ID: 0014_jar_cycle
Revises: 0013_bingo_calls
Create Date: 2026-11-25 15:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014_jar_cycle"
down_revision: str | None = "0013_bingo_calls"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("games", sa.Column("cycle_anchor_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("games", sa.Column("cycle_paused_index", sa.Integer(), nullable=True))
    op.create_check_constraint(
        op.f("ck_games_cycle_paused_index"),
        "games",
        "cycle_paused_index IS NULL OR cycle_paused_index >= 0",
    )


def downgrade() -> None:
    op.drop_constraint("ck_games_cycle_paused_index", "games", type_="check")
    op.drop_column("games", "cycle_paused_index")
    op.drop_column("games", "cycle_anchor_at")
