"""Household export (ADR-0017 §4): everything the household holds, as one zip.

`collect` reads every household table inside the request's transaction (RLS-scoped like any
read) and returns the rows plus the photo keys. `stream_zip` then writes the zip as it goes:
one JSON file per table, then each photo's original fetched from the bucket one at a time, so
memory holds one photo and the response keeps moving (no proxy idle timeout on a big album).

Credential columns never leave the database: token, password, PIN and night-code hashes are
dropped from every row. Two tables aren't exported at all: `magic_links` (only credentials)
and `photo_deletions` (keys of objects that no longer exist).
"""

from __future__ import annotations

import io
import json
import uuid
import zipfile
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import PhotoStorage, StorageUnavailable

log = structlog.get_logger()

# Every household table, in an order a reader can follow. tests pin this against the catalog.
TABLES = (
    "households",
    "settings",
    "accounts",
    "household_consents",
    "people",
    "devices",
    "device_people",
    "pin_reset_requests",
    "movies",
    "sessions",
    "options",
    "ballot_ranks",
    "ratings",
    "session_attendance",
    "photos",
    "photo_reactions",
    "audit_events",
)
# Tables without `created_at` sort by their own time column.
ORDER_BY = {
    "settings": "household_id",
    "household_consents": "accepted_at, id",
    "session_attendance": "first_seen_at, id",
}
NOT_EXPORTED = frozenset({"magic_links", "photo_deletions"})
SECRET_COLUMNS = frozenset({"token_hash", "password_hash", "pin_hash", "night_code_hash"})

README = """Family Night export: {household}
Made {made} for {by}.

One JSON file per table (tables/*.json): people, nights (sessions), the movies on each
shortlist (options, movies), votes (ballot_ranks), ratings, who was there
(session_attendance), photos and reactions, phones (devices), accounts, settings, the
Terms acceptances (household_consents) and the activity log (audit_events). Ids link the
files together; times are UTC.

photos/<night id>/<photo id>.jpg are the originals. Thumbnails are not included.

Passwords, PINs and sign-in tokens are stored only as one-way hashes and are not included.
"""


@dataclass(frozen=True)
class PhotoFile:
    path: str
    key: str


@dataclass(frozen=True)
class Export:
    filename: str
    readme: str
    tables: dict[str, list[dict[str, Any]]]
    photos: list[PhotoFile]


def _json_default(value: object) -> str:
    """uuids, datetimes, dates and decimals; everything else in a row is already JSON."""
    return value.isoformat() if isinstance(value, datetime) else str(value)


async def collect(db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID) -> Export:
    tables: dict[str, list[dict[str, Any]]] = {}
    for table in TABLES:
        order = ORDER_BY.get(table, "created_at, id")
        rows = await db.execute(text(f"SELECT * FROM {table} ORDER BY {order}"))  # noqa: S608
        tables[table] = [
            {k: v for k, v in r._mapping.items() if k not in SECRET_COLUMNS} for r in rows
        ]
    household = tables["households"][0]
    by = await db.scalar(text("SELECT email FROM accounts WHERE id = :a"), {"a": account_id})
    photos = [
        PhotoFile(f"photos/{p['session_id']}/{p['id']}.jpg", p["object_key"])
        for p in tables["photos"]
        if p["status"] in ("ready", "hidden")
    ]
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :a, 'household.exported', 'household', :h, "
            "jsonb_build_object('photos', CAST(:n AS integer)))"
        ),
        {"h": household_id, "a": account_id, "n": len(photos)},
    )
    made = datetime.now(UTC)
    return Export(
        filename=f"family-night-export-{made:%Y-%m-%d}.zip",
        readme=README.format(household=household["name"], made=made.isoformat(), by=by),
        tables=tables,
        photos=photos,
    )


class _Sink(io.RawIOBase):
    """A write-only stream that hands out what was written since the last drain."""

    def __init__(self) -> None:
        self._chunks: list[bytes] = []

    def writable(self) -> bool:
        return True

    def write(self, b: Any) -> int:
        data = bytes(b)
        self._chunks.append(data)
        return len(data)

    def drain(self) -> bytes:
        out = b"".join(self._chunks)
        self._chunks.clear()
        return out


async def stream_zip(export: Export, storage: PhotoStorage | None) -> AsyncIterator[bytes]:
    """The zip, chunk by chunk. A photo missing from the bucket is listed in MISSING.txt
    rather than failing the whole export; a storage outage ends the stream (the browser sees
    a broken download and the admin retries)."""
    sink = _Sink()
    missing: list[str] = []
    with zipfile.ZipFile(sink, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("README.txt", export.readme)
        for table, rows in export.tables.items():
            archive.writestr(
                f"tables/{table}.json",
                json.dumps(rows, default=_json_default, ensure_ascii=False, indent=1),
            )
            yield sink.drain()
        for photo in export.photos:
            data: bytes | None = None
            if storage is not None:
                try:
                    data = await storage.get(photo.key)
                except StorageUnavailable:
                    log.warning("export_storage_unavailable")
                    raise
            if data is None:
                missing.append(photo.path)
                continue
            # JPEGs are already compressed: store them.
            archive.writestr(photo.path, data, compress_type=zipfile.ZIP_STORED)
            yield sink.drain()
        if missing:
            archive.writestr("MISSING.txt", "Not found in storage:\n" + "\n".join(missing) + "\n")
    yield sink.drain()
