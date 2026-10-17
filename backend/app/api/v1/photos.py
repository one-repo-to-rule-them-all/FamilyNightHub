"""The night's photo album (ADR-0005, 03-backend.md "Photos").

Phones (device cookie) create, complete and react, always as a person bound to the
device. The album is readable by any device or account of the household; every URL in it
is a fresh presigned GET. Moderation is for accounts: hosts hide/unhide (`sessions:run`,
since they run the night in the room), admins hard-delete (`admin:photos`). Every
mutation is CSRF-protected. Another household's night or photo is a 404.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.core.dependencies import (
    AccountContext,
    AccountDb,
    CsrfProtected,
    CurrentDevice,
    CurrentViewer,
    DeviceDb,
    ViewerDb,
    require_permission,
)
from app.core.permissions import has_permission
from app.integrations.storage import PhotoStorage, configured_storage
from app.schemas.photos import (
    MyReactionOut,
    PhotoCreatedOut,
    PhotoCreateIn,
    PhotoOut,
    Reaction,
    ReactionCountOut,
)
from app.services import photo_service
from app.services.errors import (
    Conflict,
    Forbidden,
    Invalid,
    NotFound,
    ServiceError,
    Unavailable,
)

router = APIRouter(prefix="/sessions/{session_id}/photos", tags=["photos"])

CanRun = Annotated[AccountContext, Depends(require_permission("sessions:run"))]
CanDelete = Annotated[AccountContext, Depends(require_permission("admin:photos"))]


def photo_storage() -> PhotoStorage | None:
    """Overridable in tests (app.dependency_overrides) with the in-memory fake."""
    return configured_storage()


def _require_storage(
    storage: Annotated[PhotoStorage | None, Depends(photo_storage)],
) -> PhotoStorage:
    if storage is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Photo storage is not configured")
    return storage


Storage = Annotated[PhotoStorage, Depends(_require_storage)]

NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such night or photo in this household"},
    503: {"description": "Photo storage not configured or unavailable"},
}


def _raise(err: ServiceError) -> NoReturn:
    if isinstance(err, NotFound):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Photo not found") from None
    if isinstance(err, Forbidden):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, err.reason or "This device can't act as that person"
        ) from None
    if isinstance(err, Conflict):
        raise HTTPException(status.HTTP_409_CONFLICT, err.reason) from None
    if isinstance(err, Invalid):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, err.reason) from None
    if isinstance(err, Unavailable):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, err.reason) from None
    raise err  # pragma: no cover


@router.post(
    "",
    response_model=PhotoCreatedOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses={
        **NOT_FOUND,
        403: {"description": "The person is not bound to this device"},
        409: {"description": "The album isn't open (before the pick) or is full"},
    },
)
async def create_photo(
    session_id: uuid.UUID,
    body: PhotoCreateIn,
    device: CurrentDevice,
    db: DeviceDb,
    storage: Storage,
) -> PhotoCreatedOut:
    """Start an upload: a `pending` photo plus presigned PUTs for the JPEG and its thumbnail.
    PUT both, then call `complete`."""
    try:
        created = await photo_service.create(
            db,
            storage,
            device.household_id,
            device.device_id,
            session_id,
            body.person_id,
            body.taken_on,
        )
    except ServiceError as err:
        _raise(err)
    return PhotoCreatedOut(
        photo_id=created.photo_id,
        upload_url=created.upload_url,
        thumb_upload_url=created.thumb_upload_url,
        expires_in=created.expires_in,
    )


@router.post(
    "/{photo_id}/complete",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses={**NOT_FOUND, 422: {"description": "Upload missing, not a JPEG, or over 10 MB"}},
)
async def complete_photo(
    session_id: uuid.UUID,
    photo_id: uuid.UUID,
    device: CurrentDevice,
    db: DeviceDb,
    storage: Storage,
) -> Response:
    """Check both uploads (HEAD: image/jpeg, 1 byte..10 MB) and publish the photo."""
    try:
        await photo_service.complete(
            db, storage, device.household_id, device.device_id, session_id, photo_id
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("", response_model=list[PhotoOut], responses=NOT_FOUND)
async def list_photos(
    session_id: uuid.UUID, viewer: CurrentViewer, db: ViewerDb, storage: Storage
) -> list[PhotoOut]:
    """The album, newest first. URLs are minted per request and expire in 10 minutes.
    Hidden photos appear only for accounts that may unhide them."""
    include_hidden = viewer.role is not None and has_permission(viewer.role, "sessions:run")
    try:
        photos = await photo_service.album(
            db,
            storage,
            viewer.household_id,
            session_id,
            device_id=viewer.device.device_id if viewer.device else None,
            include_hidden=include_hidden,
        )
    except ServiceError as err:
        _raise(err)
    return [
        PhotoOut(
            id=p.id,
            person_id=p.person_id,
            person_name=p.person_name,
            person_avatar_emoji=p.person_avatar_emoji,
            person_color=p.person_color,
            status=p.status,
            taken_on=p.taken_on,
            created_at=p.created_at,
            url=p.url,
            thumb_url=p.thumb_url,
            reactions=[ReactionCountOut(emoji=r.emoji, count=r.count) for r in p.reactions],
            my_reactions=[
                MyReactionOut(person_id=r.person_id, emoji=r.emoji) for r in p.my_reactions
            ],
        )
        for p in photos
    ]


REACT: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such visible photo in this household"},
    403: {"description": "The person is not bound to this device"},
}


@router.put(
    "/{photo_id}/reactions/{emoji}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=REACT,
)
async def add_reaction(
    session_id: uuid.UUID,
    photo_id: uuid.UUID,
    emoji: Reaction,
    device: CurrentDevice,
    db: DeviceDb,
    person_id: Annotated[uuid.UUID, Query(description="Who is reacting")],
) -> Response:
    """Idempotent."""
    try:
        await photo_service.react(
            db, device.household_id, device.device_id, session_id, photo_id, person_id, emoji
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{photo_id}/reactions/{emoji}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=REACT,
)
async def remove_reaction(
    session_id: uuid.UUID,
    photo_id: uuid.UUID,
    emoji: Reaction,
    device: CurrentDevice,
    db: DeviceDb,
    person_id: Annotated[uuid.UUID, Query(description="Whose reaction to remove")],
) -> Response:
    """Idempotent."""
    try:
        await photo_service.unreact(
            db, device.household_id, device.device_id, session_id, photo_id, person_id, emoji
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


MODERATE: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such photo in this household"},
    409: {"description": "The photo hasn't finished uploading"},
}


@router.post(
    "/{photo_id}/hide",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=MODERATE,
)
async def hide_photo(
    session_id: uuid.UUID, photo_id: uuid.UUID, account: CanRun, db: AccountDb
) -> Response:
    """Soft hide: gone from every phone and the TV, kept for an unhide. Idempotent."""
    try:
        await photo_service.set_hidden(
            db, account.household_id, account.account_id, session_id, photo_id, hidden=True
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{photo_id}/unhide",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=MODERATE,
)
async def unhide_photo(
    session_id: uuid.UUID, photo_id: uuid.UUID, account: CanRun, db: AccountDb
) -> Response:
    try:
        await photo_service.set_hidden(
            db, account.household_id, account.account_id, session_id, photo_id, hidden=False
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{photo_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def delete_photo(
    session_id: uuid.UUID,
    photo_id: uuid.UUID,
    account: CanDelete,
    db: AccountDb,
    storage: Storage,
) -> Response:
    """Hard delete (admins): both objects, the row and its reactions. A tombstone tells the
    worker to purge the backup copies within 24h."""
    try:
        await photo_service.delete(
            db, storage, account.household_id, account.account_id, session_id, photo_id
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
