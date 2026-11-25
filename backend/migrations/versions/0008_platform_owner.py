"""platform_owner: operators, their audit trail, disabled households (ADR-0016).

- platform_operators (account_id PK -> accounts.id, granted_at, granted_by): global, no RLS.
  fnh_app may only SELECT it: rows are written by `python -m app.cli grant-platform`, which
  connects as the owner, never by the API.
- platform_audit_events: global record of every platform action. `household_ref`, not
  `household_id`, on purpose: it holds no household data and is not RLS-scoped (the RLS
  coverage test treats every `household_id` column as a household table). fnh_app may
  SELECT and INSERT only.
- households.disabled_at / disable_reminded_at: a switched-off household refuses sign-ins
  and joins; its admins are reminded yearly (ADR-0017 §4).
- fnh_platform: a NOLOGIN role owning the one SECURITY DEFINER function
  platform_list_households(), which returns metadata and counts only (ADR-0016 §3), through
  column-level grants and SELECT-only policies. Created here if provisioning hasn't (needs
  CREATEROLE, which the owner has); backend/db/init/00-init-app-role.sql creates it too.

Revision ID: 0008_platform_owner
Revises: 0007_household_deletion
Create Date: 2026-10-19 14:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008_platform_owner"
down_revision: str | None = "0007_household_deletion"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FUNCTION = "platform_list_households()"
PLATFORM_COLUMNS = {
    "households": ("id", "name", "created_at", "disabled_at", "delete_after"),
    "people": ("household_id", "merged_into_id"),
    "devices": ("household_id", "revoked_at"),
    "sessions": ("household_id",),
    "photos": ("household_id",),
    "audit_events": ("household_id", "created_at"),
}


def upgrade() -> None:
    _ensure_platform_role()
    op.add_column("households", sa.Column("disabled_at", sa.DateTime(timezone=True)))
    op.add_column("households", sa.Column("disable_reminded_at", sa.DateTime(timezone=True)))

    op.create_table(
        "platform_operators",
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column(
            "granted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("granted_by", sa.String(length=120), nullable=False),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_platform_operators_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("account_id", name=op.f("pk_platform_operators")),
    )
    op.execute("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON platform_operators FROM fnh_app")

    op.create_table(
        "platform_audit_events",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("household_ref", sa.UUID(), nullable=True),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("data", sa.dialects.postgresql.JSONB(), server_default="{}", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_platform_audit_events")),
    )
    op.create_index(
        op.f("ix_platform_audit_events_household_ref"),
        "platform_audit_events",
        ["household_ref"],
        unique=False,
    )
    op.execute("REVOKE UPDATE, DELETE, TRUNCATE ON platform_audit_events FROM fnh_app")

    # Every audit row written in a platform transaction says so (ADR-0016 §6). The API sets
    # app.platform_account for the transaction; household sessions never do.
    op.execute(
        """
        CREATE FUNCTION audit_tag_platform() RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog
        AS $$
        BEGIN
            IF NULLIF(current_setting('app.platform_account', true), '') IS NOT NULL THEN
                NEW.data := NEW.data || jsonb_build_object('via', 'platform');
            END IF;
            RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER audit_tag_platform BEFORE INSERT ON audit_events "
        "FOR EACH ROW EXECUTE FUNCTION audit_tag_platform()"
    )

    for table, columns in PLATFORM_COLUMNS.items():
        op.execute(f"GRANT SELECT ({', '.join(columns)}) ON {table} TO fnh_platform")
        op.execute(
            f"CREATE POLICY platform_metadata ON {table} FOR SELECT TO fnh_platform USING (true)"
        )
    op.execute(
        """
        CREATE FUNCTION platform_list_households()
        RETURNS TABLE (
            household_id uuid, name text, created_at timestamptz, disabled_at timestamptz,
            delete_after timestamptz, people bigint, devices bigint, nights bigint,
            photos bigint, last_activity timestamptz
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
            SELECT h.id, h.name::text, h.created_at, h.disabled_at, h.delete_after,
                (SELECT count(*) FROM public.people p
                 WHERE p.household_id = h.id AND p.merged_into_id IS NULL),
                (SELECT count(*) FROM public.devices d
                 WHERE d.household_id = h.id AND d.revoked_at IS NULL),
                (SELECT count(*) FROM public.sessions s WHERE s.household_id = h.id),
                (SELECT count(*) FROM public.photos f WHERE f.household_id = h.id),
                (SELECT max(e.created_at) FROM public.audit_events e
                 WHERE e.household_id = h.id)
            FROM public.households h
            ORDER BY h.created_at, h.id
        $$
        """
    )
    op.execute(f"ALTER FUNCTION {FUNCTION} OWNER TO fnh_platform")
    op.execute(f"REVOKE ALL ON FUNCTION {FUNCTION} FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION {FUNCTION} TO fnh_app")


def downgrade() -> None:
    op.execute(f"DROP FUNCTION {FUNCTION}")
    for table, columns in PLATFORM_COLUMNS.items():
        op.execute(f"DROP POLICY platform_metadata ON {table}")
        op.execute(f"REVOKE SELECT ({', '.join(columns)}) ON {table} FROM fnh_platform")
    op.execute("DROP TRIGGER audit_tag_platform ON audit_events")
    op.execute("DROP FUNCTION audit_tag_platform()")
    op.drop_index(
        op.f("ix_platform_audit_events_household_ref"), table_name="platform_audit_events"
    )
    op.drop_table("platform_audit_events")
    op.drop_table("platform_operators")
    op.drop_column("households", "disable_reminded_at")
    op.drop_column("households", "disabled_at")


def _ensure_platform_role() -> None:
    """Create fnh_platform like 00-init-app-role.sql does, or fail with what to run."""
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fnh_platform') THEN
                BEGIN
                    CREATE ROLE fnh_platform NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB
                        NOCREATEROLE;
                EXCEPTION WHEN insufficient_privilege THEN
                    RAISE EXCEPTION
                        'role fnh_platform missing: run db/init/00-init-app-role.sql';
                END;
            END IF;
        END
        $$;
        """
    )
    op.execute("GRANT fnh_platform TO CURRENT_USER")
    op.execute("GRANT USAGE, CREATE ON SCHEMA public TO fnh_platform")
