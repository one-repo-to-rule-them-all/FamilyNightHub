"""night_albums: photos no longer need a movie night (ADR-0019), expand step.

- `albums`: one per household per night date (household-local date, 4:00 cutoff), FORCE RLS +
  household_isolation here (ADR-0003), `UNIQUE (id, household_id)` for the composite FK.
- `settings.timezone`: IANA name, default America/Chicago (owner answer 1).
- `photos.album_id`: nullable composite FK + index; `photos.session_id` becomes nullable.
- Backfill: one album per (household, night date of the session's revealed_at or created_at);
  two nights on one date share it (owner answer 2). Every photo gets its session's album.

Safe with the previous code still running: old code never reads `album_id`, and it always
writes `session_id`. The contract step (`album_id NOT NULL`, 0017_albums_required) is a later
deploy, once no running code inserts a photo without an album (05-data.md).

The backfill runs as the migration role. FORCE RLS binds even the table owner, so the touched
tables drop FORCE for the backfill and get it back in the same transaction.

Revision ID: 0016_night_albums
Revises: 0015_loteria
Create Date: 2026-11-26 14:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016_night_albums"
down_revision: str | None = "0015_loteria"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_BACKFILL_TABLES = ("albums", "photos", "sessions", "settings")


def upgrade() -> None:
    op.add_column(
        "settings",
        sa.Column(
            "timezone",
            sa.String(length=64),
            server_default="America/Chicago",
            nullable=False,
        ),
    )
    op.create_table(
        "albums",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("night_date", sa.Date(), nullable=False),
        sa.Column("title", sa.String(length=80), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_albums_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_albums")),
        sa.UniqueConstraint("id", "household_id", name=op.f("uq_albums_id_household_id")),
        sa.UniqueConstraint(
            "household_id", "night_date", name=op.f("uq_albums_household_id_night_date")
        ),
    )
    op.create_index(op.f("ix_albums_household_id"), "albums", ["household_id"], unique=False)
    op.execute("ALTER TABLE albums ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE albums FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY household_isolation ON albums "
        "USING (household_id = app_household_id()) "
        "WITH CHECK (household_id = app_household_id())"
    )

    op.add_column("photos", sa.Column("album_id", sa.UUID(), nullable=True))
    op.create_index(op.f("ix_photos_album_id"), "photos", ["album_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_photos_album_id_household_id_albums"),
        "photos",
        "albums",
        ["album_id", "household_id"],
        ["id", "household_id"],
    )
    op.alter_column("photos", "session_id", existing_type=sa.UUID(), nullable=True)

    for table in _BACKFILL_TABLES:
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
    # The night date, in SQL: local wall clock minus the 4h cutoff (domain/albums.night_date).
    night = (
        "((COALESCE(s.revealed_at, s.created_at) "
        "AT TIME ZONE COALESCE(st.timezone, 'America/Chicago')) - interval '4 hours')::date"
    )
    op.execute(
        f"""
        INSERT INTO albums (household_id, night_date)
        SELECT DISTINCT s.household_id, {night}
        FROM photos p
        JOIN sessions s ON s.id = p.session_id AND s.household_id = p.household_id
        LEFT JOIN settings st ON st.household_id = s.household_id
        ON CONFLICT (household_id, night_date) DO NOTHING
        """  # noqa: S608
    )
    op.execute(
        f"""
        UPDATE photos p SET album_id = a.id
        FROM sessions s
        LEFT JOIN settings st ON st.household_id = s.household_id
        JOIN albums a ON a.household_id = s.household_id AND a.night_date = {night}
        WHERE s.id = p.session_id AND s.household_id = p.household_id
          AND p.album_id IS NULL
        """  # noqa: S608
    )
    for table in _BACKFILL_TABLES:
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")


def downgrade() -> None:
    # Album-only photos (no movie night) can't satisfy NOT NULL session_id. Refuse loudly
    # rather than delete family photos.
    op.execute(
        """
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM photos WHERE session_id IS NULL) THEN
            RAISE EXCEPTION 'photos without a movie night exist; export them before downgrading';
          END IF;
        END $$
        """
    )
    op.alter_column("photos", "session_id", existing_type=sa.UUID(), nullable=False)
    op.drop_constraint(op.f("fk_photos_album_id_household_id_albums"), "photos", type_="foreignkey")
    op.drop_index(op.f("ix_photos_album_id"), table_name="photos")
    op.drop_column("photos", "album_id")
    op.drop_index(op.f("ix_albums_household_id"), table_name="albums")
    op.drop_table("albums")
    op.drop_column("settings", "timezone")
