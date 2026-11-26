"""0016_night_albums backfill (ADR-0019 §5): one album per household per session night date.

Downgrades to 0015, writes pre-album rows as the owner (the shape old code wrote), upgrades,
and checks every photo got the album of its night's date. Two nights on one date share one
album (owner answer 2); the 4:00 cutoff and the household timezone decide the date.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, text

from app.core.config import settings

pytestmark = pytest.mark.integration

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _cfg() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    return cfg


@pytest.fixture
def owner() -> Iterator[Engine]:
    engine = create_engine(settings.MIGRATION_DATABASE_URL)
    try:
        yield engine
    finally:
        engine.dispose()


def test_backfill_files_each_photo_into_its_nights_date_album(owner: Engine) -> None:
    command.downgrade(_cfg(), "0015_loteria")
    hid = uuid.uuid4()
    try:
        with owner.begin() as c:
            c.execute(text("ALTER TABLE households NO FORCE ROW LEVEL SECURITY"))
            for t in ("people", "sessions", "photos", "settings", "accounts"):
                c.execute(text(f"ALTER TABLE {t} NO FORCE ROW LEVEL SECURITY"))
            c.execute(
                text("INSERT INTO households (id, name, join_slug) VALUES (:h, 'Backfill', :slug)"),
                {"h": hid, "slug": f"bf{hid.hex[:10]}"},
            )
            person = c.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color) "
                    "VALUES (:h, 'Kid', '🐙', '#38bdf8') RETURNING id"
                ),
                {"h": hid},
            ).scalar_one()

            def night(revealed: str | None, created: str) -> uuid.UUID:
                sid: uuid.UUID = c.execute(
                    text(
                        "INSERT INTO sessions (household_id, night_code_hash, status, "
                        "revealed_at, created_at) VALUES (:h, :nc, 'closed', "
                        "CAST(:r AS timestamptz), CAST(:c AS timestamptz)) RETURNING id"
                    ),
                    {"h": hid, "nc": uuid.uuid4().hex, "r": revealed, "c": created},
                ).scalar_one()
                return sid

            def photo(sid: uuid.UUID) -> uuid.UUID:
                pid = uuid.uuid4()
                c.execute(
                    text(
                        "INSERT INTO photos (id, household_id, session_id, person_id, "
                        "object_key, thumb_key, status) VALUES (:p, :h, :s, :person, :k, "
                        ":tk, 'ready')"
                    ),
                    {
                        "p": pid,
                        "h": hid,
                        "s": sid,
                        "person": person,
                        "k": f"households/{hid}/sessions/{sid}/{pid}.jpg",
                        "tk": f"households/{hid}/sessions/{sid}/{pid}_thumb.jpg",
                    },
                )
                return pid

            # Thursday 26 Nov in Chicago (CST = UTC-6): revealed 19:00 local.
            thu_a = night("2026-11-27T01:00:00Z", "2026-11-26T20:00:00Z")
            # A second movie night the same evening, revealed 01:30 Friday local: still Thursday.
            thu_b = night("2026-11-27T07:30:00Z", "2026-11-27T05:00:00Z")
            # Never revealed: falls back to created_at, Saturday 28 Nov 18:00 local.
            sat = night(None, "2026-11-29T00:00:00Z")
            photos = {
                photo(thu_a): "2026-11-26",
                photo(thu_b): "2026-11-26",
                photo(sat): "2026-11-28",
            }
            for t in ("households", "people", "sessions", "photos", "settings", "accounts"):
                c.execute(text(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY"))

        command.upgrade(_cfg(), "head")

        with owner.begin() as c:
            c.execute(text("SET LOCAL app.household_id = :h".replace(":h", f"'{hid}'")))
            rows = c.execute(
                text(
                    "SELECT p.id, p.object_key, a.night_date FROM photos p "
                    "JOIN albums a ON a.id = p.album_id AND a.household_id = p.household_id "
                    "WHERE p.household_id = :h"
                ),
                {"h": hid},
            ).all()
            albums = c.execute(
                text("SELECT count(*) FROM albums WHERE household_id = :h"), {"h": hid}
            ).scalar_one()
        assert {r.id: r.night_date.isoformat() for r in rows} == photos
        assert albums == 2  # the two Thursday nights share one album
        # Existing keys are not moved (ADR-0019 §2).
        assert all("/sessions/" in r.object_key for r in rows)
    finally:
        command.upgrade(_cfg(), "head")
        with owner.begin() as c:
            c.execute(text("SET LOCAL app.household_id = :h".replace(":h", f"'{hid}'")))
            c.execute(text("DELETE FROM photos WHERE household_id = :h"), {"h": hid})
            c.execute(text("DELETE FROM households WHERE id = :h"), {"h": hid})
