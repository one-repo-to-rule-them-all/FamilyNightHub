"""The night's photo album: presign, complete, list, react, hide, delete (ADR-0005).

Photo bytes never pass through the API. `create` inserts a `pending` row and hands back
presigned PUTs; the phone uploads straight to the bucket and calls `complete`, which
HEADs both objects and only then marks the photo `ready`. Every URL the album returns is
minted here, per request, *after* the session has been found in the caller's household,
so another household's id (or no credential at all) never yields a URL.

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

from app.domain import session_state
from app.domain.session_state import SessionRuleError
from app.integrations.storage import JPEG, PUT_TTL_SECONDS, PhotoStorage, StorageUnavailable
from app.realtime import events
from app.realtime.publisher import publish_after_commit
from app.services import people_service
from app.services.errors import Conflict, Invalid, NotFound, Unavailable

# The photos.bytes check constraint (migration 0001) and ADR-0005.
MAX_BYTES = 10 * 1024 * 1024
# A backstop against a runaway upload queue, far above a family's ~30 photos a night.
MAX_PHOTOS_PER_NIGHT = 500
# Small on purpose: the album is for the family, not a comment section.
REACTIONS: tuple[str, ...] = ("❤️", "😂", "😮", "👍", "🎉", "🍿")

Actor = tuple[Literal["device", "account"], uuid.UUID]


@dataclass(frozen=True)
class CreatedPhoto:
    photo_id: uuid.UUID
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


def object_keys(
    household_id: uuid.UUID, session_id: uuid.UUID, photo_id: uuid.UUID
) -> tuple[str, str]:
    """05-data.md key layout: the full image and its thumbnail."""
    base = f"households/{household_id}/sessions/{session_id}/{photo_id}"
    return f"{base}.jpg", f"{base}_thumb.jpg"


_AUDIT = text(
    "INSERT INTO audit_events (household_id, actor_account_id, actor_device_id, action, "
    "target_type, target_id, data) VALUES (:h, :a, :d, :action, 'photo', :t, :data)"
).bindparams(bindparam("data", type_=JSONB))


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    actor: Actor,
    action: str,
    photo_id: uuid.UUID,
    data: dict[str, Any] | None = None,
) -> None:
    kind, actor_id = actor
    await db.execute(
        _AUDIT,
        {
            "h": household_id,
            "a": actor_id if kind == "account" else None,
            "d": actor_id if kind == "device" else None,
            "action": action,
            "t": photo_id,
            "data": data or {},
        },
    )


async def _session_status(db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID) -> str:
    """The night's effective status; NotFound if absent or another household's."""
    row = (
        await db.execute(
            text("SELECT status, revealed_at FROM sessions WHERE id = :s AND household_id = :h"),
            {"s": session_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    return session_state.effective_status(row.status, row.revealed_at, datetime.now(UTC))


async def _lock_photo(
    db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID, photo_id: uuid.UUID
) -> Any:
    row = (
        await db.execute(
            text(
                "SELECT id, person_id, uploaded_by_device_id, object_key, thumb_key, status "
                "FROM photos WHERE id = :p AND session_id = :s AND household_id = :h "
                "FOR UPDATE"
            ),
            {"p": photo_id, "s": session_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    return row


async def create(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    session_id: uuid.UUID,
    person_id: uuid.UUID,
    taken_on: date | None,
) -> CreatedPhoto:
    status = await _session_status(db, household_id, session_id)
    await people_service.require_can_act_as(db, device_id, person_id)
    try:
        session_state.check_photos_open(status)
    except SessionRuleError as err:
        raise Conflict(err.reason) from None
    count: int = await db.scalar(
        text("SELECT count(*) FROM photos WHERE session_id = :s"), {"s": session_id}
    )
    if count >= MAX_PHOTOS_PER_NIGHT:
        raise Conflict(f"This night already has {MAX_PHOTOS_PER_NIGHT} photos")

    photo_id = uuid.uuid4()
    key, thumb_key = object_keys(household_id, session_id, photo_id)
    await db.execute(
        text(
            "INSERT INTO photos (id, household_id, session_id, person_id, "
            "uploaded_by_device_id, object_key, thumb_key, taken_at, status) "
            "VALUES (:id, :h, :s, :p, :d, :k, :tk, :taken, 'pending')"
        ),
        {
            "id": photo_id,
            "h": household_id,
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
        upload_url=storage.presign_put(key),
        thumb_upload_url=storage.presign_put(thumb_key),
        expires_in=PUT_TTL_SECONDS,
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
    session_id: uuid.UUID,
    photo_id: uuid.UUID,
) -> None:
    """Verify both uploads, then `pending -> ready`. Idempotent once ready. Only the device
    that created the photo may complete it; to any other caller a pending photo does not
    exist. A failed check leaves the row pending (the worker sweeps it after 24h)."""
    photo = await _lock_photo(db, household_id, session_id, photo_id)
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
    publish_after_commit(db, session_id, events.PHOTO_ADDED)


async def album(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    device_id: uuid.UUID | None,
    include_hidden: bool,
) -> list[PhotoView]:
    """Ready photos (plus hidden ones for moderators), newest first, each with fresh
    presigned GETs. `my_reactions` covers the people actively bound to `device_id`."""
    await _session_status(db, household_id, session_id)
    statuses = ["ready", "hidden"] if include_hidden else ["ready"]
    rows = (
        await db.execute(
            text(
                "SELECT ph.id, ph.person_id, ph.status, ph.taken_at, ph.created_at, "
                "ph.object_key, ph.thumb_key, pe.name, pe.avatar_emoji, pe.color "
                "FROM photos ph JOIN people pe "
                "  ON pe.id = ph.person_id AND pe.household_id = ph.household_id "
                "WHERE ph.session_id = :s AND ph.household_id = :h "
                "  AND ph.status IN :statuses "
                "ORDER BY ph.created_at DESC, ph.id"
            ).bindparams(bindparam("statuses", expanding=True)),
            {"s": session_id, "h": household_id, "statuses": statuses},
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


async def _ready_photo(
    db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID, photo_id: uuid.UUID
) -> None:
    found = await db.scalar(
        text(
            "SELECT 1 FROM photos WHERE id = :p AND session_id = :s AND household_id = :h "
            "AND status = 'ready'"
        ),
        {"p": photo_id, "s": session_id, "h": household_id},
    )
    if found is None:
        raise NotFound


async def react(
    db: AsyncSession,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    session_id: uuid.UUID,
    photo_id: uuid.UUID,
    person_id: uuid.UUID,
    emoji: str,
) -> None:
    """Idempotent. Only on visible (`ready`) photos, only as a person bound to the device."""
    if emoji not in REACTIONS:
        raise Invalid("Not one of the album's reactions")
    await _ready_photo(db, household_id, session_id, photo_id)
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
    session_id: uuid.UUID,
    photo_id: uuid.UUID,
    person_id: uuid.UUID,
    emoji: str,
) -> None:
    """Idempotent: removing a reaction that isn't there succeeds."""
    if emoji not in REACTIONS:
        raise Invalid("Not one of the album's reactions")
    await _ready_photo(db, household_id, session_id, photo_id)
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
    session_id: uuid.UUID,
    photo_id: uuid.UUID,
    hidden: bool,
) -> None:
    """Soft moderation: `ready <-> hidden`. Idempotent; a pending photo can't be hidden."""
    photo = await _lock_photo(db, household_id, session_id, photo_id)
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
        {"session_id": str(session_id)},
    )


async def delete(
    db: AsyncSession,
    storage: PhotoStorage,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    session_id: uuid.UUID,
    photo_id: uuid.UUID,
) -> None:
    """Hard delete (admins): tombstone + row (reactions cascade) + both objects.

    The DB writes go first so a constraint failure leaves the objects alone; the objects
    go last, inside the transaction, so a storage outage rolls the whole delete back and
    it can simply be retried (S3 deletes are idempotent)."""
    photo = await _lock_photo(db, household_id, session_id, photo_id)
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
        {"session_id": str(session_id), "person_id": str(photo.person_id)},
    )
    await db.flush()
    try:
        await storage.delete(photo.object_key)
        await storage.delete(photo.thumb_key)
    except StorageUnavailable:
        raise Unavailable("Photo storage is unavailable; try again shortly") from None
