"""slideshow_control: the host's Start/Stop for the TV slideshow (issue #41).

Two nullable timestamps on `sessions`: `slideshow_started_at` (the host pressed Start; the TV
plays from that moment) and `slideshow_stopped_at` (the host pressed Stop; the TV holds). Both
null is `auto`, the behaviour before this migration: the TV plays as soon as the night is
`tonight`. A check keeps at most one set. A timestamp rather than a boolean, so a second Start
restarts the slideshow (the TV keys on it) and the audit trail and the row agree on when.

`sessions` already has ENABLE + FORCE RLS and its household policy (0001); new columns inherit
both, so there is no policy to add. Existing rows get NULLs (auto): nothing changes for them.

Revision ID: 0003_slideshow_control
Revises: 0002_voting_methods_ranks
Create Date: 2026-10-17 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_slideshow_control"
down_revision: str | None = "0002_voting_methods_ranks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sessions", sa.Column("slideshow_started_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "sessions", sa.Column("slideshow_stopped_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_sessions_slideshow_one_state"),
        "sessions",
        "num_nonnulls(slideshow_started_at, slideshow_stopped_at) <= 1",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_sessions_slideshow_one_state"), "sessions", type_="check")
    op.drop_column("sessions", "slideshow_stopped_at")
    op.drop_column("sessions", "slideshow_started_at")
