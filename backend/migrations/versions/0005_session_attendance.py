"""session_attendance: who is here tonight (guest-flow spec G8, ADR-0014's current person).

One row per (night, person), written when a phone whose *current* person is X opens the night
(mints an SSE ticket) or casts a ballot as X. `GET /sessions/{id}/present` reads it together
with the ballots: ids and avatars only, never ranks. Household-scoped with FORCE RLS and the
usual composite (x_id, household_id) FKs.

Revision ID: 0005_session_attendance
Revises: 0004_slideshow_control
Create Date: 2026-10-17 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_session_attendance"
# Rebase pending: 0004_slideshow_control (PR #46) is not on main yet. Set this to it then.
down_revision: str | None = "0004_slideshow_control"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "session_attendance",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("person_id", sa.UUID(), nullable=False),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_session_attendance_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["person_id", "household_id"],
            ["people.id", "people.household_id"],
            name=op.f("fk_session_attendance_person_id_household_id_people"),
        ),
        sa.ForeignKeyConstraint(
            ["session_id", "household_id"],
            ["sessions.id", "sessions.household_id"],
            name=op.f("fk_session_attendance_session_id_household_id_sessions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_session_attendance")),
        sa.UniqueConstraint(
            "session_id", "person_id", name=op.f("uq_session_attendance_session_id_person_id")
        ),
    )
    op.create_index(
        op.f("ix_session_attendance_household_id"),
        "session_attendance",
        ["household_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_session_attendance_person_id"), "session_attendance", ["person_id"], unique=False
    )
    # ADR-0003: FORCE RLS + household_isolation, in the same migration as the table.
    op.execute("ALTER TABLE session_attendance ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE session_attendance FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY household_isolation ON session_attendance "
        "USING (household_id = app_household_id()) "
        "WITH CHECK (household_id = app_household_id())"
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_session_attendance_person_id"), table_name="session_attendance")
    op.drop_index(op.f("ix_session_attendance_household_id"), table_name="session_attendance")
    op.drop_table("session_attendance")
