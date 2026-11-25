"""tv_target: which game the household's paired TV is told to show (ADR-0018 amendment).

One row per household at most. `game_id` is the game a host sent to the TV; no row (or a
deleted game, via the cascade) means "no game sent". FORCE RLS + household_isolation ship in
this migration (ADR-0003); the composite FK keeps the pointer inside the household.

Revision ID: 0012_tv_target
Revises: 0011_scattergories
Create Date: 2026-11-25 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012_tv_target"
down_revision: str | None = "0011_scattergories"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "household_tv_target",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("game_id", sa.UUID(), nullable=False),
        sa.Column("set_by_account_id", sa.UUID(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_household_tv_target_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["game_id", "household_id"],
            ["games.id", "games.household_id"],
            name=op.f("fk_household_tv_target_game_id_household_id_games"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("household_id", name=op.f("pk_household_tv_target")),
    )
    op.execute("ALTER TABLE household_tv_target ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE household_tv_target FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY household_isolation ON household_tv_target "
        "USING (household_id = app_household_id()) "
        "WITH CHECK (household_id = app_household_id())"
    )


def downgrade() -> None:
    op.drop_table("household_tv_target")
