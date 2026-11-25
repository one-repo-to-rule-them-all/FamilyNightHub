"""bingo_calls: the numbers a host has called in a classic bingo game (ADR-0018 amendment, A).

One row per call: `seq` is the 0-based call number, `value` the number 1-75. Unique on
(game, seq) and (game, value), so a number can never repeat and two draws cannot share a slot.
FORCE RLS + household_isolation ship here (ADR-0003); the composite FK keeps a call inside its
game's household. No person column, so person merge and delete leave it alone; it goes with
its game (cascade, including Start fresh).

Revision ID: 0013_bingo_calls
Revises: 0012_tv_target
Create Date: 2026-11-25 14:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013_bingo_calls"
down_revision: str | None = "0012_tv_target"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "bingo_calls",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("game_id", sa.UUID(), nullable=False),
        sa.Column("seq", sa.SmallInteger(), nullable=False),
        sa.Column("value", sa.SmallInteger(), nullable=False),
        sa.Column(
            "called_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_bingo_calls_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["game_id", "household_id"],
            ["games.id", "games.household_id"],
            name=op.f("fk_bingo_calls_game_id_household_id_games"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bingo_calls")),
        sa.UniqueConstraint("game_id", "seq", name=op.f("uq_bingo_calls_game_id_seq")),
        sa.UniqueConstraint("game_id", "value", name=op.f("uq_bingo_calls_game_id_value")),
        sa.CheckConstraint("value BETWEEN 1 AND 75", name=op.f("ck_bingo_calls_value_range")),
        sa.CheckConstraint("seq >= 0", name=op.f("ck_bingo_calls_seq_nonneg")),
    )
    op.create_index(op.f("ix_bingo_calls_household_id"), "bingo_calls", ["household_id"])
    op.create_index(op.f("ix_bingo_calls_game_id"), "bingo_calls", ["game_id"])
    op.execute("ALTER TABLE bingo_calls ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE bingo_calls FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY household_isolation ON bingo_calls "
        "USING (household_id = app_household_id()) "
        "WITH CHECK (household_id = app_household_id())"
    )


def downgrade() -> None:
    op.drop_table("bingo_calls")
