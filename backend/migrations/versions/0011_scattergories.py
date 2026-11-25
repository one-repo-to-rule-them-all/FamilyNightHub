"""scattergories: rounds and answers (ADR-0018 slice C).

- scatter_rounds: one row per round of a scattergories game. `categories` is a jsonb array of
  strings snapshotted at start, so a later list edit cannot change a round in play. The server
  stores `ends_at`; the round's effective state (running / closed / revealed) is derived from
  it on read, so no timer job exists. `revealed_at` freezes the answers.
- scatter_answers: one row per (round, person, category). `host_verdict` is the host's override
  after reveal. Scores are never stored: they are derived on read from these rows.

Both tables ship FORCE RLS + household_isolation here (ADR-0003) and composite
(x_id, household_id) FKs.

Revision ID: 0011_scattergories
Revises: 0010_bingo
Create Date: 2026-11-25 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0011_scattergories"
down_revision: str | None = "0010_bingo"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_TABLES = ("scatter_rounds", "scatter_answers")


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
        "scatter_rounds",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("game_id", sa.UUID(), nullable=False),
        sa.Column("round_no", sa.Integer(), nullable=False),
        sa.Column("letter", sa.String(length=1), nullable=False),
        sa.Column("categories", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("duration_seconds", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=_now(), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revealed_at", sa.DateTime(timezone=True), nullable=True),
        _household_fk("scatter_rounds"),
        sa.ForeignKeyConstraint(
            ["game_id", "household_id"],
            ["games.id", "games.household_id"],
            name=op.f("fk_scatter_rounds_game_id_household_id_games"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_scatter_rounds")),
        sa.UniqueConstraint("id", "household_id", name=op.f("uq_scatter_rounds_id_household_id")),
        sa.UniqueConstraint("game_id", "round_no", name=op.f("uq_scatter_rounds_game_id_round_no")),
        sa.CheckConstraint("round_no >= 1", name=op.f("ck_scatter_rounds_round_no")),
        sa.CheckConstraint(
            "duration_seconds BETWEEN 10 AND 900", name=op.f("ck_scatter_rounds_duration")
        ),
    )
    op.create_index(op.f("ix_scatter_rounds_household_id"), "scatter_rounds", ["household_id"])
    op.create_index(op.f("ix_scatter_rounds_game_id"), "scatter_rounds", ["game_id"])

    op.create_table(
        "scatter_answers",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("round_id", sa.UUID(), nullable=False),
        sa.Column("person_id", sa.UUID(), nullable=False),
        sa.Column("category_index", sa.Integer(), nullable=False),
        sa.Column("text", sa.String(length=60), nullable=False),
        sa.Column("host_verdict", sa.String(length=10), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_now(), nullable=False),
        _household_fk("scatter_answers"),
        sa.ForeignKeyConstraint(
            ["round_id", "household_id"],
            ["scatter_rounds.id", "scatter_rounds.household_id"],
            name=op.f("fk_scatter_answers_round_id_household_id_scatter_rounds"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["person_id", "household_id"],
            ["people.id", "people.household_id"],
            name=op.f("fk_scatter_answers_person_id_household_id_people"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_scatter_answers")),
        sa.UniqueConstraint(
            "round_id",
            "person_id",
            "category_index",
            name=op.f("uq_scatter_answers_round_id_person_id_category_index"),
        ),
        sa.CheckConstraint("category_index >= 0", name=op.f("ck_scatter_answers_category_index")),
        sa.CheckConstraint(
            "char_length(text) BETWEEN 1 AND 60", name=op.f("ck_scatter_answers_text_length")
        ),
        sa.CheckConstraint(
            "host_verdict IN ('accepted', 'rejected')", name=op.f("ck_scatter_answers_verdict")
        ),
    )
    op.create_index(op.f("ix_scatter_answers_household_id"), "scatter_answers", ["household_id"])
    op.create_index(op.f("ix_scatter_answers_round_id"), "scatter_answers", ["round_id"])
    op.create_index(op.f("ix_scatter_answers_person_id"), "scatter_answers", ["person_id"])

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
    op.drop_table("scatter_answers")
    op.drop_table("scatter_rounds")
