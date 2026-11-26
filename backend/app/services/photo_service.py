"""Photo albums: presign, complete, list, react, hide, delete (ADR-0005, ADR-0019).

A photo lives in its night album (one per household per night date); a movie night is optional.
Every per-photo operation takes a `Scope`: the legacy `/sessions/{id}/photos` routes look photos
up by `session_id`, the `/albums/{id}/photos` routes by `album_id`. Both upload paths file new
photos into the night's date album, so either id reaches the same row.

Photo bytes never pass through the API. `create` inserts a `pending` row and hands back
presigned PUTs; the phone uploads straight to the bucket and calls `complete`, which
HEADs both objects and only then marks the photo `ready`. Every URL the album returns is
minted here, per request, *after* the night or album has been found in the caller's
household, so another household's id (or no credential at all) never yields a URL.

Hard delete removes the row, both objects and writes a `photo_deletions` tombstone in one
transaction; the worker purges the backup copies from the tombstone (06).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from typing import Any, Literal

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import albums as album_rules
from app.domain import session_state
from app.domain.session_state import SessionRuleError
from app.integrations.storage import JPEG, PUT_TTL_SECONDS, PhotoStorage, StorageUnavailable
from app.realtime import events
from app.realtime.publisher import publish_after_commit
from app.services import consent_service, people_service
from app.services.errors import Conflict, Invalid, NotFound, Unavailable

# The photos.bytes check constraint (migration 0001) and ADR-0005.
MAX_BYTES = 10 * 1024 * 1024
# A backstop against a runaway upload queue, far above a family's ~30 photos a night.
MAX_PHOTOS_PER_NIGHT = 500
# Small on purpose: the album is for the family, not a comment section.
REACTIONS: tuple[str, ...] = ("❤️", "😂", "😮", "👍", "🎉", "🍿")

Actor = tuple[Literal["device", "account"], uuid.UUID]


@dataclass(frozen=True)
class Scope:
    """Which route a photo is reached through. `column` is a fixed literal, never input."""

    column: Literal["session_id", "album_id"]
    id: uuid.UUID


def by_session(session_id: uuid.UUID) -> Scope:
    return Scope("session_id", session_id)


def by_album(album_id: uuid.UUID) -> Scope:
    return Scope("album_id", album_id)


@dataclass(frozen=True)
class CreatedPhoto:
    photo_id: uuid.UUID
    album_id: uuid.UUID
    upload_url: str
    thumb_upload_url: str
    expires_in: int


@dataclass(frozen=True)
class ReactionCount:
    emoji: str
    count: int


@dataclass(frozen=True)
class MyReaction:
    person_id: uuid.UUID
    emoji: str


@dataclass(frozen=True)
class PhotoView:
    id: uuid.UUID
    person_id: uuid.UUID
    person_name: str
    person_avatar_emoji: str
    person_color: str
    status: str
    taken_on: date | None
    created_at: datetime
    url: str
    thumb_url: str
    reactions: list[ReactionCount]
    my_reactions: list[MyReaction]


@dataclass(frozen=True)
class AlbumView:
    id: uuid.UUID | None
    night_date: date
    title: str | None
    display_title: str
    photo_count: int
    cover_thumb_url: str | None
    uploads_open: bool
    is_tonight: bool


def object_keys(
    household_id: uuid.UUID, album_id: uuid.UUID, photo_id: uuid.UUID
) -> tuple[str, str]:
    """05-data.md key layout (ADR-0019): the full image and its thumbnail. Photos uploaded
    before 0016 keep their `sessions/...` keys; every reader uses the key on the row."""
    base = f"households/{household_id}/albums/{album_id}/{photo_id}"
    return f"{base}.jpg", f"{base}_thumb.jpg"


_AUDIT = text(
    "INSERT INTO audit_events (household_id, actor_account_id, actor_device_id, action, "
    "target_type, target_id, data) VALUES (:h, :a, :d, :action, :tt, :t, :data)"
).bindparams(bindparam("data", type_=JSONB))


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    actor: Actor,
    action: str,
    target_id: uuid.UUID,
    data: dict[str, Any] | None = None,
    target_type: str = "photo",
) -> None:
    kind, actor_id = actor
    await db.execute(
        _AUDIT,
        {
            "h": household_id,
            "a": actor_id if kind == "account" else None,
            "d": actor_id if kind == "device" else None,
            "action": action,
            "tt": target_type,
            "t": target_id,
            "data": data or {},
        },
    )


async def _session_row(db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID) -> Any:
    """NotFound if absent or another household's."""
    row = (
        await db.execute(
            text(
                "SELECT status, revealed_at, created_at FROM sessions "
                "WHERE id = :s AND household_id = :h"
            ),
            {"s": session_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    return row


async def household_timezone(db: AsyncSession, household_id: uuid.UUID) -> str:
    tz = await db.scalar(
        text("SELECT timezone FROM settings WHERE household_id = :h"), {"h": household_id}
    )
    return tz if tz and album_rules.is_valid_timezone(tz) else album_rules.DEFAULT_TIMEZONE


async def tonight(db: AsyncSession, household_id: uuid.UUID) -> date:
    return album_rules.night_date(datetime.now(UTC), await household_timezone(db, household_id))


async def ensure_album(db: AsyncSession, household_id: uuid.UUID, night: date) -> uuid.UUID:
    """The night's album, created on first use. Two phones racing both land on one row: the
    loser's INSERT waits for the winner's commit and does nothing, then reads it."""
    await db.execute(
        text(
            "INSERT INTO albums (household_id, night_date) VALUES (:h, :d) "
            "ON CONFLICT (household_id, night_date) DO NOTHING"
        ),
        {"h": household_id, "d": night},
    )
    album_id: uuid.UUID = (
        await db.execute(
            text("SELECT id FROM albums WHERE household_id = :h AND night_date = :d"),
            {"h": household_id, "d": night},
        )
    ).scalar_one()
    return album_id


async def _album_row(db: AsyncSession, household_id: uuid.UUID, album_id: uuid.UUID) -> Any:
    row = (
        await db.execute(
            text("SELECT id, night_date, title FROM albums WHERE id = :a AND household_id = :h"),
            {"a": album_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    return row


async def _require_scope(db: AsyncSession, household_id: uuid.UUID, scope: Scope) -> None:
    if scope.column == "album_id":
        await _album_row(db, household_id, scope.id)
    else:
        await _session_row(db, household_id, scope.id)


async def _lock_photo(
    db: AsyncSession, household_id: uuid.UUID, scope: Scope, photo_id: uuid.UUID
) -> Any:
    row = (
        await db.execute(
            text(
                "SELECT id, person_id, session_id, album_id, uploaded_by_device_id, object_key, "
                f"thumb_key, status FROM photos WHERE id = :p AND {scope.column} = :s "
                "AND household_id = :h FOR UPDATE"
            ),
            {"p": photo_id, "s": scope.id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    return row


def _where(photo: Any) -> dict[str, str]:
    out = {"album_id": str(photo.album_id)} if photo.album_id else {}
    if photo.session_id:
        out["session_id"] = str(photo.session_id)
    return out


# --- Upload -------------------------------------------------------------------------------


async def _insert_photo(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    album_id: uuid.UUID,
    album_night: date,
    session_id: uuid.UUID | None,
    person_id: uuid.UUID,
    taken_on: date | None,
) -> CreatedPhoto:
    """Shared by both upload paths: the upload window, the per-album cap, then the row."""
    if not album_rules.uploads_open(album_night, await tonight(db, household_id)):
        raise Conflict("This album is closed to new photos")
    count: int = await db.scalar(
        text("SELECT count(*) FROM photos WHERE album_id = :a"), {"a": album_id}
    )
    if count >= MAX_PHOTOS_PER_NIGHT:
        raise Conflict(f"This night already has {MAX_PHOTOS_PER_NIGHT} photos")

    photo_id = uuid.uuid4()
    key, thumb_key = object_keys(household_id, album_id, photo_id)
    await db.execute(
        text(
            "INSERT INTO photos (id, household_id, album_id, session_id, person_id, "
            "uploaded_by_device_id, object_key, thumb_key, taken_at, status) "
            "VALUES (:id, :h, :a, :s, :p, :d, :k, :tk, :taken, 'pending')"
        ),
        {
            "id": photo_id,
            "h": household_id,
            "a": album_id,
            "s": session_id,
            "p": person_id,
            "d": device_id,
            "k": key,
            "tk": thumb_key,
            # EXIF gives the phone a date only; stored as midnight UTC of that day.
            "taken": datetime.combine(taken_on, time(), UTC) if taken_on else None,
        },
    )
    return CreatedPhoto(
        photo_id=photo_id,
        album_id=album_id,
        upload_url=storage.presign_put(key),
        thumb_upload_url=storage.presign_put(thumb_key),
        expires_in=PUT_TTL_SECONDS,
    )


async def create(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    session_id: uuid.UUID,
    person_id: uuid.UUID,
    taken_on: date | None,
) -> CreatedPhoto:
    """The movie-night path (ADR-0005): still gated on the night's status; the photo is filed
    into the album of the night's date (revealed_at, else created_at), as 0016 backfilled."""
    row = await _session_row(db, household_id, session_id)
    status = session_state.effective_status(row.status, row.revealed_at, datetime.now(UTC))
    await people_service.require_can_act_as(db, device_id, person_id)
    await consent_service.require_household_consent(db)
    try:
        session_state.check_photos_open(status)
    except SessionRuleError as err:
        raise Conflict(err.reason) from None
    night = album_rules.night_date(
        row.revealed_at or row.created_at, await household_timezone(db, household_id)
    )
    album_id = await ensure_album(db, household_id, night)
    return await _insert_photo(
        db, storage, household_id, device_id, album_id, night, session_id, person_id, taken_on
    )


async def create_in_album(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    album_id: uuid.UUID | None,
    person_id: uuid.UUID,
    taken_on: date | None,
) -> CreatedPhoto:
    """ADR-0019: `album_id=None` is tonight's album (created lazily); no movie night needed.
    Same person and consent rules as the night path; a past album closes 3 days after."""
    night: date | None = None
    if album_id is not None:
        night = (await _album_row(db, household_id, album_id)).night_date
    await people_service.require_can_act_as(db, device_id, person_id)
    await consent_service.require_household_consent(db)
    if album_id is None or night is None:
        night = await tonight(db, household_id)
        album_id = await ensure_album(db, household_id, night)
    return await _insert_photo(
        db, storage, household_id, device_id, album_id, night, None, person_id, taken_on
    )


async def _check_object(storage: PhotoStorage, key: str, what: str) -> int:
    try:
        info = await storage.head(key)
    except StorageUnavailable:
        raise Unavailable("Photo storage is unavailable; try again shortly") from None
    if info is None:
        raise Invalid(f"The {what} was not uploaded")
    if (info.content_type or "").split(";")[0].strip().lower() != JPEG:
        raise Invalid(f"The {what} must be a JPEG")
    if not 0 < info.size <= MAX_BYTES:
        raise Invalid(f"The {what} must be between 1 byte and 10 MB")
    return info.size


async def complete(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    scope: Scope,
    photo_id: uuid.UUID,
) -> None:
    """Verify both uploads, then `pending -> ready`. Idempotent once ready. Only the device
    that created the photo may complete it; to any other caller a pending photo does not
    exist. A failed check leaves the row pending (the worker sweeps it after 24h)."""
    photo = await _lock_photo(db, household_id, scope, photo_id)
    if photo.uploaded_by_device_id != device_id:
        raise NotFound
    if photo.status != "pending":
        return
    size = await _check_object(storage, photo.object_key, "photo")
    await _check_object(storage, photo.thumb_key, "thumbnail")
    await db.execute(
        text("UPDATE photos SET status = 'ready', bytes = :b WHERE id = :p"),
        {"b": size, "p": photo_id},
    )
    if photo.session_id is not None:
        publish_after_commit(db, photo.session_id, events.PHOTO_ADDED)


# --- Read ---------------------------------------------------------------------------------


async def album(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    scope: Scope,
    *,
    device_id: uuid.UUID | None,
    include_hidden: bool,
) -> list[PhotoView]:
    """Ready photos (plus hidden ones for moderators), newest first, each with fresh
    presigned GETs, minted only after the night or album was found in this household.
    `my_reactions` covers the people actively bound to `device_id`."""
    await _require_scope(db, household_id, scope)
    statuses = ["ready", "hidden"] if include_hidden else ["ready"]
    rows = (
        await db.execute(
            text(
                "SELECT ph.id, ph.person_id, ph.status, ph.taken_at, ph.created_at, "
                "ph.object_key, ph.thumb_key, pe.name, pe.avatar_emoji, pe.color "
                "FROM photos ph JOIN people pe "
                "  ON pe.id = ph.person_id AND pe.household_id = ph.household_id "
                f"WHERE ph.{scope.column} = :s AND ph.household_id = :h "
                "  AND ph.status IN :statuses "
                "ORDER BY ph.created_at DESC, ph.id"
            ).bindparams(bindparam("statuses", expanding=True)),
            {"s": scope.id, "h": household_id, "statuses": statuses},
        )
    ).all()
    if not rows:
        return []

    ids = [r.id for r in rows]
    counts: dict[uuid.UUID, list[ReactionCount]] = {}
    for r in await db.execute(
        text(
            "SELECT photo_id, emoji, count(*) AS n FROM photo_reactions "
            "WHERE photo_id IN :ids GROUP BY photo_id, emoji ORDER BY photo_id, emoji"
        ).bindparams(bindparam("ids", expanding=True)),
        {"ids": ids},
    ):
        counts.setdefault(r.photo_id, []).append(ReactionCount(r.emoji, r.n))

    mine: dict[uuid.UUID, list[MyReaction]] = {}
    if device_id is not None:
        for r in await db.execute(
            text(
                "SELECT pr.photo_id, pr.person_id, pr.emoji FROM photo_reactions pr "
                "JOIN device_people dp ON dp.person_id = pr.person_id "
                "  AND dp.device_id = :d AND dp.status = 'active' "
                "WHERE pr.photo_id IN :ids ORDER BY pr.photo_id, pr.person_id, pr.emoji"
            ).bindparams(bindparam("ids", expanding=True)),
            {"ids": ids, "d": device_id},
        ):
            mine.setdefault(r.photo_id, []).append(MyReaction(r.person_id, r.emoji))

    return [
        PhotoView(
            id=r.id,
            person_id=r.person_id,
            person_name=r.name,
            person_avatar_emoji=r.avatar_emoji,
            person_color=r.color,
            status=r.status,
            taken_on=r.taken_at.astimezone(UTC).date() if r.taken_at else None,
            created_at=r.created_at,
            url=storage.presign_get(r.object_key),
            thumb_url=storage.presign_get(r.thumb_key),
            reactions=counts.get(r.id, []),
            my_reactions=mine.get(r.id, []),
        )
        for r in rows
    ]


_ALBUMS = """
    SELECT a.id, a.night_date, a.title,
           (SELECT count(*) FROM photos p WHERE p.album_id = a.id AND p.status IN :statuses)
             AS n,
           (SELECT p.thumb_key FROM photos p WHERE p.album_id = a.id AND p.status = 'ready'
            ORDER BY p.created_at DESC, p.id LIMIT 1) AS cover
    FROM albums a
"""


def _album_view(storage: PhotoStorage, r: Any, today: date) -> AlbumView:
    return AlbumView(
        id=r.id,
        night_date=r.night_date,
        title=r.title,
        display_title=r.title or album_rules.default_title(r.night_date),
        photo_count=r.n,
        cover_thumb_url=storage.presign_get(r.cover) if r.cover else None,
        uploads_open=album_rules.uploads_open(r.night_date, today),
        is_tonight=r.night_date == today,
    )


def _statuses(include_hidden: bool) -> list[str]:
    return ["ready", "hidden"] if include_hidden else ["ready"]


async def list_albums(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    *,
    limit: int,
    include_hidden: bool,
) -> list[AlbumView]:
    """Recent albums with at least one visible photo, newest night first, with a cover."""
    today = await tonight(db, household_id)
    rows = (
        await db.execute(
            text(
                f"SELECT * FROM ({_ALBUMS} WHERE a.household_id = :h) x "  # noqa: S608
                "WHERE x.n > 0 ORDER BY x.night_date DESC LIMIT :lim"
            ).bindparams(bindparam("statuses", expanding=True)),
            {"h": household_id, "lim": limit, "statuses": _statuses(include_hidden)},
        )
    ).all()
    return [_album_view(storage, r, today) for r in rows]


async def get_album(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    album_id: uuid.UUID | None,
    *,
    include_hidden: bool,
) -> AlbumView:
    """One album; `None` is tonight's, which may not exist yet (then `id` is None, empty)."""
    today = await tonight(db, household_id)
    where, params = (
        ("a.household_id = :h AND a.night_date = :d", {"d": today})
        if album_id is None
        else ("a.household_id = :h AND a.id = :a", {"a": album_id})
    )
    row = (
        await db.execute(
            text(f"{_ALBUMS} WHERE {where}").bindparams(  # noqa: S608
                bindparam("statuses", expanding=True)
            ),
            {"h": household_id, "statuses": _statuses(include_hidden), **params},
        )
    ).first()
    if row is None:
        if album_id is not None:
            raise NotFound
        return AlbumView(
            id=None,
            night_date=today,
            title=None,
            display_title=album_rules.default_title(today),
            photo_count=0,
            cover_thumb_url=None,
            uploads_open=True,
            is_tonight=True,
        )
    return _album_view(storage, row, today)


async def album_for_session(
    db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID
) -> uuid.UUID:
    """The album of a movie night's date (for the `/albums/[session]` redirect)."""
    row = await _session_row(db, household_id, session_id)
    night = album_rules.night_date(
        row.revealed_at or row.created_at, await household_timezone(db, household_id)
    )
    found = await db.scalar(
        text("SELECT id FROM albums WHERE household_id = :h AND night_date = :d"),
        {"h": household_id, "d": night},
    )
    if found is None:
        raise NotFound
    album_id: uuid.UUID = found
    return album_id


async def rename(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    album_id: uuid.UUID,
    title: str | None,
) -> None:
    """Hosts name a night ("Thanksgiving 2026"); `None` goes back to the date label."""
    row = await _album_row(db, household_id, album_id)
    await db.execute(
        text("UPDATE albums SET title = :t WHERE id = :a"), {"t": title, "a": album_id}
    )
    await _audit(
        db,
        household_id,
        ("account", account_id),
        "album.renamed",
        album_id,
        {"from": row.title, "to": title},
        target_type="album",
    )


async def drop_empty_albums(db: AsyncSession, album_ids: list[uuid.UUID]) -> None:
    """ADR-0019 §4: an album whose last photo went (person delete) goes in the same
    transaction. Only the given albums, so a phone's freshly created album is never raced."""
    if not album_ids:
        return
    await db.execute(
        text(
            "DELETE FROM albums a WHERE a.id IN :ids "
            "AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.album_id = a.id)"
        ).bindparams(bindparam("ids", expanding=True)),
        {"ids": album_ids},
    )


# --- React and moderate -------------------------------------------------------------------


async def _ready_photo(
    db: AsyncSession, household_id: uuid.UUID, scope: Scope, photo_id: uuid.UUID
) -> None:
    found = await db.scalar(
        text(
            f"SELECT 1 FROM photos WHERE id = :p AND {scope.column} = :s AND household_id = :h "
            "AND status = 'ready'"
        ),
        {"p": photo_id, "s": scope.id, "h": household_id},
    )
    if found is None:
        raise NotFound


async def react(
    db: AsyncSession,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    scope: Scope,
    photo_id: uuid.UUID,
    person_id: uuid.UUID,
    emoji: str,
) -> None:
    """Idempotent. Only on visible (`ready`) photos, only as a person bound to the device."""
    if emoji not in REACTIONS:
        raise Invalid("Not one of the album's reactions")
    await _ready_photo(db, household_id, scope, photo_id)
    await people_service.require_can_act_as(db, device_id, person_id)
    await db.execute(
        text(
            "INSERT INTO photo_reactions (household_id, photo_id, person_id, emoji) "
            "VALUES (:h, :p, :person, :e) "
            "ON CONFLICT (photo_id, person_id, emoji) DO NOTHING"
        ),
        {"h": household_id, "p": photo_id, "person": person_id, "e": emoji},
    )


async def unreact(
    db: AsyncSession,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    scope: Scope,
    photo_id: uuid.UUID,
    person_id: uuid.UUID,
    emoji: str,
) -> None:
    """Idempotent: removing a reaction that isn't there succeeds."""
    if emoji not in REACTIONS:
        raise Invalid("Not one of the album's reactions")
    await _ready_photo(db, household_id, scope, photo_id)
    await people_service.require_can_act_as(db, device_id, person_id)
    await db.execute(
        text(
            "DELETE FROM photo_reactions WHERE photo_id = :p AND person_id = :person AND emoji = :e"
        ),
        {"p": photo_id, "person": person_id, "e": emoji},
    )


async def set_hidden(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    scope: Scope,
    photo_id: uuid.UUID,
    hidden: bool,
) -> None:
    """Soft moderation: `ready <-> hidden`. Idempotent; a pending photo can't be hidden.
    Not limited by the upload window: admins and hosts moderate past albums too."""
    photo = await _lock_photo(db, household_id, scope, photo_id)
    target = "hidden" if hidden else "ready"
    if photo.status == target:
        return
    if photo.status == "pending":
        raise Conflict("This photo hasn't finished uploading")
    await db.execute(
        text("UPDATE photos SET status = :t WHERE id = :p"), {"t": target, "p": photo_id}
    )
    await _audit(
        db,
        household_id,
        ("account", account_id),
        "photo.hidden" if hidden else "photo.unhidden",
        photo_id,
        _where(photo),
    )


async def delete(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    scope: Scope,
    photo_id: uuid.UUID,
) -> None:
    """Hard delete (admins): tombstone + row (reactions cascade) + both objects.

    The DB writes go first so a constraint failure leaves the objects alone; the objects
    go last, inside the transaction, so a storage outage rolls the whole delete back and
    it can simply be retried (S3 deletes are idempotent)."""
    photo = await _lock_photo(db, household_id, scope, photo_id)
    await db.execute(
        text(
            "INSERT INTO photo_deletions (household_id, photo_id, object_key, thumb_key) "
            "VALUES (:h, :p, :k, :tk)"
        ),
        {"h": household_id, "p": photo_id, "k": photo.object_key, "tk": photo.thumb_key},
    )
    await db.execute(text("DELETE FROM photos WHERE id = :p"), {"p": photo_id})
    await _audit(
        db,
        household_id,
        ("account", account_id),
        "photo.deleted",
        photo_id,
        {**_where(photo), "person_id": str(photo.person_id)},
    )
    await db.flush()
    try:
        await storage.delete(photo.object_key)
        await storage.delete(photo.thumb_key)
    except StorageUnavailable:
        raise Unavailable("Photo storage is unavailable; try again shortly") from None
