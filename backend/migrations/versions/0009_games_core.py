"""games_core: games, their roster and the Gratitude Jar's notes (ADR-0018 slice A).

- games: one row per game (a jar, later a bingo round or scattergories game). Household-scoped,
  not attached to a night. `config` is validated per kind in the service, `reveal_seed` is the
  jar's stored shuffle seed.
- game_players: the roster (used by bingo and scattergories from the next slices).
- gratitude_notes: a person's note; `reveal_position` is set when the host starts the reveal.

Every table ships FORCE RLS + household_isolation here (ADR-0003) and composite
(x_id, household_id) FKs, so a row can never point at another household's person or game.

Revision ID: 0009_games_core
Revises: 0008_platform_owner
Create Date: 2026-11-24 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009_games_core"
down_revision: str | None = "0008_platform_owner"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_TABLES = ("games", "game_players", "gratitude_notes")


def _household_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["household_id"],
        ["households.id"],
        name=op.f(f"fk_{table}_household_id_households"),
        ondelete="CASCADE",
    )


def _now() -> sa.TextClause:
    return sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "games",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=80), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("created_by_account_id", sa.UUID(), nullable=False),
        sa.Column("reveal_seed", sa.Numeric(precision=20, scale=0), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_now(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        _household_fk("games"),
        sa.ForeignKeyConstraint(
            ["created_by_account_id", "household_id"],
            ["accounts.id", "accounts.household_id"],
            name=op.f("fk_games_created_by_account_id_household_id_accounts"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_games")),
        sa.UniqueConstraint("id", "household_id", name=op.f("uq_games_id_household_id")),
        sa.CheckConstraint(
            "kind IN ('gratitude_jar', 'bingo', 'scattergories')", name=op.f("ck_games_kind")
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'open', 'live', 'ended')", name=op.f("ck_games_status")
        ),
    )
    op.create_index(op.f("ix_games_household_id"), "games", ["household_id"])

    op.create_table(
        "game_players",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("game_id", sa.UUID(), nullable=False),
        sa.Column("person_id", sa.UUID(), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=_now(), nullable=False),
        _household_fk("game_players"),
        sa.ForeignKeyConstraint(
            ["game_id", "household_id"],
            ["games.id", "games.household_id"],
            name=op.f("fk_game_players_game_id_household_id_games"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["person_id", "household_id"],
            ["people.id", "people.household_id"],
            name=op.f("fk_game_players_person_id_household_id_people"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_game_players")),
        sa.UniqueConstraint("game_id", "person_id", name=op.f("uq_game_players_game_id_person_id")),
    )
    op.create_index(op.f("ix_game_players_household_id"), "game_players", ["household_id"])
    op.create_index(op.f("ix_game_players_person_id"), "game_players", ["person_id"])

    op.create_table(
        "gratitude_notes",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("game_id", sa.UUID(), nullable=False),
        sa.Column("person_id", sa.UUID(), nullable=False),
        sa.Column("body", sa.String(length=280), nullable=False),
        sa.Column("anonymous", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("reveal_position", sa.Integer(), nullable=True),
        sa.Column("revealed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("hidden_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_now(), nullable=False),
        _household_fk("gratitude_notes"),
        sa.ForeignKeyConstraint(
            ["game_id", "household_id"],
            ["games.id", "games.household_id"],
            name=op.f("fk_gratitude_notes_game_id_household_id_games"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["person_id", "household_id"],
            ["people.id", "people.household_id"],
            name=op.f("fk_gratitude_notes_person_id_household_id_people"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_gratitude_notes")),
        sa.UniqueConstraint(
            "game_id", "reveal_position", name=op.f("uq_gratitude_notes_game_id_reveal_position")
        ),
        sa.CheckConstraint(
            "char_length(body) BETWEEN 1 AND 280", name=op.f("ck_gratitude_notes_body_length")
        ),
    )
    op.create_index(op.f("ix_gratitude_notes_household_id"), "gratitude_notes", ["household_id"])
    op.create_index(op.f("ix_gratitude_notes_game_id"), "gratitude_notes", ["game_id"])
    op.create_index(op.f("ix_gratitude_notes_person_id"), "gratitude_notes", ["person_id"])

    # ADR-0003: FORCE RLS + household_isolation, in the same migration as each table.
    for table in NEW_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY household_isolation ON {table} "
            "USING (household_id = app_household_id()) "
            "WITH CHECK (household_id = app_household_id())"
        )


def downgrade() -> None:
    op.drop_table("gratitude_notes")
    op.drop_table("game_players")
    op.drop_table("games")
