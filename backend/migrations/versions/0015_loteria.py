"""loteria: a fourth game kind (ADR-0018 amendment 2026-11-26).

No new tables. A tabla is 16 cards, so `bingo_cards.squares` may now hold 16 or 25 entries, and
`games.kind` accepts `loteria`. Calls reuse `bingo_calls` (value 1-54 fits its 1-75 CHECK, and its
unique indexes already forbid a repeat). Every person-lifecycle path (export, delete, Start fresh,
merge) and every RLS pin already covers both tables, so nothing else changes. FORCE RLS and the
household composite FKs are those of 0010/0013, untouched.

Downgrade deletes Lotería games (cascading their cards and calls) before the old CHECKs return.

Revision ID: 0015_loteria
Revises: 0014_jar_cycle
Create Date: 2026-11-26 10:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "0015_loteria"
down_revision: str | None = "0014_jar_cycle"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_games_kind"), "games", type_="check")
    op.create_check_constraint(
        op.f("ck_games_kind"),
        "games",
        "kind IN ('gratitude_jar', 'bingo', 'scattergories', 'loteria')",
    )
    op.drop_constraint(op.f("ck_bingo_cards_squares_25"), "bingo_cards", type_="check")
    op.create_check_constraint(
        op.f("ck_bingo_cards_squares_count"), "bingo_cards", "cardinality(squares) IN (16, 25)"
    )


def downgrade() -> None:
    op.execute("DELETE FROM games WHERE kind = 'loteria'")
    op.drop_constraint(op.f("ck_bingo_cards_squares_count"), "bingo_cards", type_="check")
    op.create_check_constraint(
        op.f("ck_bingo_cards_squares_25"), "bingo_cards", "cardinality(squares) = 25"
    )
    op.drop_constraint(op.f("ck_games_kind"), "games", type_="check")
    op.create_check_constraint(
        op.f("ck_games_kind"), "games", "kind IN ('gratitude_jar', 'bingo', 'scattergories')"
    )
