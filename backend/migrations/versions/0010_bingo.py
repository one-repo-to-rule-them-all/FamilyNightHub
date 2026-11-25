"""bingo: one stored card per player per bingo game (ADR-0018 slice B).

- bingo_cards: `squares` is the 25 strings snapshotted from the pool when the person joined
  (so a later pool edit cannot change a card in play); `marked_mask` is a 25-bit int;
  `won_at` is set by the marking that completes the pattern. Unique per (game, person).

FORCE RLS + household_isolation ship here (ADR-0003), with composite (x_id, household_id)
FKs so a card can never point at another household's person or game.

Revision ID: 0010_bingo
Revises: 0009_games_core
Create Date: 2026-11-25 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0010_bingo"
down_revision: str | None = "0009_games_core"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "bingo_cards",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("game_id", sa.UUID(), nullable=False),
        sa.Column("person_id", sa.UUID(), nullable=False),
        sa.Column("squares", postgresql.ARRAY(sa.String(length=80)), nullable=False),
        sa.Column("marked_mask", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("won_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_bingo_cards_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["game_id", "household_id"],
            ["games.id", "games.household_id"],
            name=op.f("fk_bingo_cards_game_id_household_id_games"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["person_id", "household_id"],
            ["people.id", "people.household_id"],
            name=op.f("fk_bingo_cards_person_id_household_id_people"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bingo_cards")),
        sa.UniqueConstraint("game_id", "person_id", name=op.f("uq_bingo_cards_game_id_person_id")),
        sa.CheckConstraint("cardinality(squares) = 25", name=op.f("ck_bingo_cards_squares_25")),
        sa.CheckConstraint(
            "marked_mask BETWEEN 0 AND 33554431", name=op.f("ck_bingo_cards_marked_mask_range")
        ),
    )
    op.create_index(op.f("ix_bingo_cards_household_id"), "bingo_cards", ["household_id"])
    op.create_index(op.f("ix_bingo_cards_game_id"), "bingo_cards", ["game_id"])
    op.create_index(op.f("ix_bingo_cards_person_id"), "bingo_cards", ["person_id"])

    op.execute("ALTER TABLE bingo_cards ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE bingo_cards FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY household_isolation ON bingo_cards "
        "USING (household_id = app_household_id()) "
        "WITH CHECK (household_id = app_household_id())"
    )


def downgrade() -> None:
    op.drop_table("bingo_cards")
