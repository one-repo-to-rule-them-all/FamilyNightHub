"""household_consents: Terms and Privacy acceptances, the consent gate's record (ADR-0017 §2).

Household-scoped with FORCE RLS and a composite FK to accounts. Append-only at the database:
`fnh_app` keeps SELECT and INSERT but loses UPDATE and DELETE, so a consent can't be edited
or erased by the API. A household delete still removes the rows: referential actions run as
the table owner.

Revision ID: 0006_household_consents
Revises: 0005_session_attendance
Create Date: 2026-10-19 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_household_consents"
down_revision: str | None = "0005_session_attendance"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "household_consents",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("terms_version", sa.String(length=32), nullable=False),
        sa.Column("privacy_version", sa.String(length=32), nullable=False),
        sa.Column("guardian", sa.Boolean(), server_default="false", nullable=False),
        sa.Column(
            "accepted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("role IN ('admin', 'host')", name=op.f("ck_household_consents_role")),
        sa.ForeignKeyConstraint(
            ["account_id", "household_id"],
            ["accounts.id", "accounts.household_id"],
            name=op.f("fk_household_consents_account_id_household_id_accounts"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_household_consents_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_household_consents")),
    )
    op.create_index(
        op.f("ix_household_consents_account_id"),
        "household_consents",
        ["account_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_household_consents_household_id"),
        "household_consents",
        ["household_id"],
        unique=False,
    )
    # ADR-0003: FORCE RLS + household_isolation, in the same migration as the table.
    op.execute("ALTER TABLE household_consents ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE household_consents FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY household_isolation ON household_consents "
        "USING (household_id = app_household_id()) "
        "WITH CHECK (household_id = app_household_id())"
    )
    # ADR-0017: a consent record is never edited or erased by the app.
    op.execute("REVOKE UPDATE, DELETE, TRUNCATE ON household_consents FROM fnh_app")


def downgrade() -> None:
    op.drop_index(op.f("ix_household_consents_household_id"), table_name="household_consents")
    op.drop_index(op.f("ix_household_consents_account_id"), table_name="household_consents")
    op.drop_table("household_consents")
