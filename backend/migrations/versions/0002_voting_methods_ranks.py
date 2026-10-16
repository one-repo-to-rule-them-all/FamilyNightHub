"""voting_methods_ranks: widen rank and ballot_size checks to 1..8 for approval (ADR-0010).

An approval ballot may approve the whole shortlist (up to MAX_OPTIONS = 8). It is stored
in ballot_ranks as ordinals 1..m, which keeps unique (session, person, rank) intact, so
only the two 1..3 checks change. Both tables already have FORCE RLS (0001); no new table,
no policy change. top3's own limit (rank <= 3) stays enforced in domain/voting.

Revision ID: 0002_voting_methods_ranks
Revises: 0001
Create Date: 2026-10-15 21:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002_voting_methods_ranks"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_ballot_ranks_rank"), "ballot_ranks", type_="check")
    op.create_check_constraint(op.f("ck_ballot_ranks_rank"), "ballot_ranks", "rank BETWEEN 1 AND 8")
    op.drop_constraint(op.f("ck_sessions_ballot_size"), "sessions", type_="check")
    op.create_check_constraint(
        op.f("ck_sessions_ballot_size"), "sessions", "ballot_size BETWEEN 1 AND 8"
    )


def downgrade() -> None:
    # Fails loudly if an approval night already stored a rank or ballot_size above 3.
    op.drop_constraint(op.f("ck_sessions_ballot_size"), "sessions", type_="check")
    op.create_check_constraint(
        op.f("ck_sessions_ballot_size"), "sessions", "ballot_size BETWEEN 1 AND 3"
    )
    op.drop_constraint(op.f("ck_ballot_ranks_rank"), "ballot_ranks", type_="check")
    op.create_check_constraint(op.f("ck_ballot_ranks_rank"), "ballot_ranks", "rank BETWEEN 1 AND 3")
