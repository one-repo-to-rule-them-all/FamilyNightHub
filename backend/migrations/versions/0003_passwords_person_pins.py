"""passwords_person_pins: account passwords, per-person PINs, PIN resets (ADR-0014).

- accounts: username (unique case-insensitively), password_hash, password_changed_at.
- people: pin_hash, pin_set_at, pin_failed_attempts, pin_locked_at, name_changed_at.
- device_people: is_current, at most one per device (partial unique index).
- pin_reset_requests: new household table, FORCE RLS + household_isolation in this
  migration (05-data.md "Migrations"), composite FKs to people/devices/accounts.
- auth_resolve_account_by_username(text): the sixth ADR-0009 resolver, with a column grant
  on accounts.username. The resolver never sees password_hash.

All columns are nullable or defaulted, so this is expand-only: the running app keeps working
until the new code ships.

Revision ID: 0003_passwords_person_pins
Revises: 0002_voting_methods_ranks
Create Date: 2026-10-17 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_passwords_person_pins"
down_revision: str | None = "0002_voting_methods_ranks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RESOLVER_FUNCTION = "auth_resolve_account_by_username(text)"


def upgrade() -> None:
    op.add_column("accounts", sa.Column("username", sa.String(length=32), nullable=True))
    op.add_column("accounts", sa.Column("password_hash", sa.String(length=255), nullable=True))
    op.add_column(
        "accounts", sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_accounts_username"), "accounts", "username ~ '^[a-z0-9._-]{3,32}$'"
    )
    op.create_index(
        "uq_accounts_username_lower",
        "accounts",
        [sa.literal_column("lower(username)")],
        unique=True,
    )

    op.add_column("people", sa.Column("pin_hash", sa.String(length=255), nullable=True))
    op.add_column("people", sa.Column("pin_set_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "people",
        sa.Column("pin_failed_attempts", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column("people", sa.Column("pin_locked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("people", sa.Column("name_changed_at", sa.DateTime(timezone=True), nullable=True))

    op.add_column(
        "device_people",
        sa.Column("is_current", sa.Boolean(), server_default="false", nullable=False),
    )
    op.create_index(
        "uq_device_people_current",
        "device_people",
        ["device_id"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )

    op.create_table(
        "pin_reset_requests",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("person_id", sa.UUID(), nullable=False),
        sa.Column("requested_by_device_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="open", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by_account_id", sa.UUID(), nullable=True),
        sa.CheckConstraint(
            "status IN ('open', 'approved', 'dismissed')",
            name=op.f("ck_pin_reset_requests_status"),
        ),
        sa.CheckConstraint(
            "(status = 'open') = (resolved_at IS NULL)",
            name=op.f("ck_pin_reset_requests_resolved_when_closed"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_pin_reset_requests_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["person_id", "household_id"],
            ["people.id", "people.household_id"],
            name=op.f("fk_pin_reset_requests_person_id_household_id_people"),
        ),
        sa.ForeignKeyConstraint(
            ["requested_by_device_id", "household_id"],
            ["devices.id", "devices.household_id"],
            name=op.f("fk_pin_reset_requests_requested_by_device_id_household_id_devices"),
        ),
        sa.ForeignKeyConstraint(
            ["resolved_by_account_id", "household_id"],
            ["accounts.id", "accounts.household_id"],
            name=op.f("fk_pin_reset_requests_resolved_by_account_id_household_id_accounts"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pin_reset_requests")),
    )
    op.create_index(
        op.f("ix_pin_reset_requests_household_id"),
        "pin_reset_requests",
        ["household_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_pin_reset_requests_person_id"), "pin_reset_requests", ["person_id"], unique=False
    )
    op.create_index(
        "uq_pin_reset_requests_open",
        "pin_reset_requests",
        ["person_id"],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
    )

    # ADR-0003: FORCE RLS + the same household_isolation policy as every 0001 table.
    op.execute("ALTER TABLE pin_reset_requests ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE pin_reset_requests FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY household_isolation ON pin_reset_requests "
        "USING (household_id = app_household_id()) "
        "WITH CHECK (household_id = app_household_id())"
    )

    # ADR-0009 / ADR-0014: one more column for the resolver (accounts already has its
    # resolver_lookup policy from 0001), and the sixth function.
    op.execute("GRANT SELECT (username) ON accounts TO fnh_resolver")
    op.execute(
        """
        CREATE FUNCTION auth_resolve_account_by_username(p_username text)
        RETURNS TABLE (account_id uuid, household_id uuid)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
            SELECT a.id, a.household_id FROM public.accounts a
            WHERE lower(a.username) = lower(p_username) AND a.disabled_at IS NULL
        $$
        """
    )
    op.execute(f"ALTER FUNCTION {RESOLVER_FUNCTION} OWNER TO fnh_resolver")
    op.execute(f"REVOKE ALL ON FUNCTION {RESOLVER_FUNCTION} FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION {RESOLVER_FUNCTION} TO fnh_app")


def downgrade() -> None:
    op.execute(f"DROP FUNCTION IF EXISTS {RESOLVER_FUNCTION}")
    op.execute("REVOKE SELECT (username) ON accounts FROM fnh_resolver")
    op.drop_index("uq_pin_reset_requests_open", table_name="pin_reset_requests")
    op.drop_index(op.f("ix_pin_reset_requests_person_id"), table_name="pin_reset_requests")
    op.drop_index(op.f("ix_pin_reset_requests_household_id"), table_name="pin_reset_requests")
    op.drop_table("pin_reset_requests")
    op.drop_index("uq_device_people_current", table_name="device_people")
    op.drop_column("device_people", "is_current")
    op.drop_column("people", "name_changed_at")
    op.drop_column("people", "pin_locked_at")
    op.drop_column("people", "pin_failed_attempts")
    op.drop_column("people", "pin_set_at")
    op.drop_column("people", "pin_hash")
    op.drop_index("uq_accounts_username_lower", table_name="accounts")
    op.drop_constraint(op.f("ck_accounts_username"), "accounts", type_="check")
    op.drop_column("accounts", "password_changed_at")
    op.drop_column("accounts", "password_hash")
    op.drop_column("accounts", "username")
