"""Night albums (ADR-0019, 03-backend.md "Photos"): photos no longer need a movie night.

One album per household per night date (household timezone, 4:00 cutoff), created lazily on
the first upload. Same rules as the movie-night album (`photos.py`): phones upload as a person
bound to the device, behind the consent gate; any device or account reads; hosts
(`sessions:run`) hide, unhide and rename; admins (`admin:photos`) hard-delete. Every URL is
minted per request after the album was found in the caller's household; another household's
album is a 404. `/tonight` routes are declared before `/{album_id}` so the literal wins.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Query, Response, status

from app.api.v1.photos import NOT_FOUND, CanDelete, CanRun, Storage, _raise, photo_out
from app.core.dependencies import (
    AccountDb,
    CsrfProtected,
    CurrentDevice,
    CurrentViewer,
    DeviceDb,
    ViewerDb,
)
from app.core.permissions import has_permission
from app.schemas.photos import (
    AlbumOut,
    AlbumPhotoCreatedOut,
    AlbumRenameIn,
    PhotoCreateIn,
    PhotoOut,
    Reaction,
)
from app.services import photo_service
from app.services.errors import ServiceError

router = APIRouter(prefix="/albums", tags=["albums"])

UPLOAD: dict[int | str, dict[str, Any]] = {
    **NOT_FOUND,
    403: {"description": "The person is not bound to this device, or Terms not accepted"},
    409: {"description": "The album is closed to new photos (3 days after) or is full"},
}


def _out(a: photo_service.AlbumView) -> AlbumOut:
    return AlbumOut(
        id=a.id,
        night_date=a.night_date,
        title=a.title,
        display_title=a.display_title,
        photo_count=a.photo_count,
        cover_thumb_url=a.cover_thumb_url,
        uploads_open=a.uploads_open,
        is_tonight=a.is_tonight,
    )


def _created(c: photo_service.CreatedPhoto) -> AlbumPhotoCreatedOut:
    return AlbumPhotoCreatedOut(
        photo_id=c.photo_id,
        album_id=c.album_id,
        upload_url=c.upload_url,
        thumb_upload_url=c.thumb_upload_url,
        expires_in=c.expires_in,
    )


def _moderator(viewer: Any) -> bool:
    return viewer.role is not None and has_permission(viewer.role, "sessions:run")


@router.get("", response_model=list[AlbumOut])
async def list_albums(
    viewer: CurrentViewer,
    db: ViewerDb,
    storage: Storage,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[AlbumOut]:
    """Recent albums with at least one photo, newest night first, each with a cover."""
    albums = await photo_service.list_albums(
        db, storage, viewer.household_id, limit=limit, include_hidden=_moderator(viewer)
    )
    return [_out(a) for a in albums]


@router.get("/tonight", response_model=AlbumOut)
async def tonight_album(viewer: CurrentViewer, db: ViewerDb, storage: Storage) -> AlbumOut:
    """Tonight's album. Before its first photo it doesn't exist yet: `id` is null."""
    return _out(
        await photo_service.get_album(
            db, storage, viewer.household_id, None, include_hidden=_moderator(viewer)
        )
    )


@router.post(
    "/tonight/photos",
    response_model=AlbumPhotoCreatedOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses=UPLOAD,
)
async def create_tonight_photo(
    body: PhotoCreateIn, device: CurrentDevice, db: DeviceDb, storage: Storage
) -> AlbumPhotoCreatedOut:
    """Start an upload into tonight's album (created on first use; no movie night needed).
    PUT both URLs, then call `/albums/{album_id}/photos/{photo_id}/complete`."""
    try:
        created = await photo_service.create_in_album(
            db,
            storage,
            device.household_id,
            device.device_id,
            None,
            body.person_id,
            body.taken_on,
        )
    except ServiceError as err:
        _raise(err)
    return _created(created)


@router.get("/tonight/photos", response_model=list[PhotoOut])
async def list_tonight_photos(
    viewer: CurrentViewer, db: ViewerDb, storage: Storage
) -> list[PhotoOut]:
    """Tonight's photos; empty before the album's first photo."""
    album = await photo_service.get_album(
        db, storage, viewer.household_id, None, include_hidden=_moderator(viewer)
    )
    if album.id is None:
        return []
    photos = await photo_service.album(
        db,
        storage,
        viewer.household_id,
        photo_service.by_album(album.id),
        device_id=viewer.device.device_id if viewer.device else None,
        include_hidden=_moderator(viewer),
    )
    return [photo_out(p) for p in photos]


@router.get("/by-session/{session_id}", response_model=AlbumOut, responses=NOT_FOUND)
async def album_for_session(
    session_id: uuid.UUID, viewer: CurrentViewer, db: ViewerDb, storage: Storage
) -> AlbumOut:
    """The album of a movie night's date (404 until it has one), for `/albums/[session]`."""
    try:
        album_id = await photo_service.album_for_session(db, viewer.household_id, session_id)
        album = await photo_service.get_album(
            db, storage, viewer.household_id, album_id, include_hidden=_moderator(viewer)
        )
    except ServiceError as err:
        _raise(err)
    return _out(album)


@router.get("/{album_id}", response_model=AlbumOut, responses=NOT_FOUND)
async def get_album(
    album_id: uuid.UUID, viewer: CurrentViewer, db: ViewerDb, storage: Storage
) -> AlbumOut:
    try:
        album = await photo_service.get_album(
            db, storage, viewer.household_id, album_id, include_hidden=_moderator(viewer)
        )
    except ServiceError as err:
        _raise(err)
    return _out(album)


@router.patch(
    "/{album_id}", response_model=AlbumOut, dependencies=[CsrfProtected], responses=NOT_FOUND
)
async def rename_album(
    album_id: uuid.UUID,
    body: AlbumRenameIn,
    account: CanRun,
    db: AccountDb,
    storage: Storage,
) -> AlbumOut:
    """Hosts name the night ("Thanksgiving 2026"); null goes back to the date label."""
    try:
        await photo_service.rename(
            db, account.household_id, account.account_id, album_id, body.title
        )
        album = await photo_service.get_album(
            db, storage, account.household_id, album_id, include_hidden=True
        )
    except ServiceError as err:
        _raise(err)
    return _out(album)


@router.post(
    "/{album_id}/photos",
    response_model=AlbumPhotoCreatedOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses=UPLOAD,
)
async def create_album_photo(
    album_id: uuid.UUID,
    body: PhotoCreateIn,
    device: CurrentDevice,
    db: DeviceDb,
    storage: Storage,
) -> AlbumPhotoCreatedOut:
    """Add to a past album: allowed for its night date plus 3 days, then 409."""
    try:
        created = await photo_service.create_in_album(
            db,
            storage,
            device.household_id,
            device.device_id,
            album_id,
            body.person_id,
            body.taken_on,
        )
    except ServiceError as err:
        _raise(err)
    return _created(created)


@router.get("/{album_id}/photos", response_model=list[PhotoOut], responses=NOT_FOUND)
async def list_album_photos(
    album_id: uuid.UUID, viewer: CurrentViewer, db: ViewerDb, storage: Storage
) -> list[PhotoOut]:
    """The album, newest first; same shape as the movie night's. URLs expire in 10 minutes.
    Hidden photos appear only for accounts that may unhide them."""
    try:
        photos = await photo_service.album(
            db,
            storage,
            viewer.household_id,
            photo_service.by_album(album_id),
            device_id=viewer.device.device_id if viewer.device else None,
            include_hidden=_moderator(viewer),
        )
    except ServiceError as err:
        _raise(err)
    return [photo_out(p) for p in photos]


@router.post(
    "/{album_id}/photos/{photo_id}/complete",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses={**NOT_FOUND, 422: {"description": "Upload missing, not a JPEG, or over 10 MB"}},
)
async def complete_album_photo(
    album_id: uuid.UUID,
    photo_id: uuid.UUID,
    device: CurrentDevice,
    db: DeviceDb,
    storage: Storage,
) -> Response:
    try:
        await photo_service.complete(
            db,
            storage,
            device.household_id,
            device.device_id,
            photo_service.by_album(album_id),
            photo_id,
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/{album_id}/photos/{photo_id}/reactions/{emoji}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def add_album_reaction(
    album_id: uuid.UUID,
    photo_id: uuid.UUID,
    emoji: Reaction,
    device: CurrentDevice,
    db: DeviceDb,
    person_id: Annotated[uuid.UUID, Query(description="Who is reacting")],
) -> Response:
    try:
        await photo_service.react(
            db,
            device.household_id,
            device.device_id,
            photo_service.by_album(album_id),
            photo_id,
            person_id,
            emoji,
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{album_id}/photos/{photo_id}/reactions/{emoji}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def remove_album_reaction(
    album_id: uuid.UUID,
    photo_id: uuid.UUID,
    emoji: Reaction,
    device: CurrentDevice,
    db: DeviceDb,
    person_id: Annotated[uuid.UUID, Query(description="Whose reaction to remove")],
) -> Response:
    try:
        await photo_service.unreact(
            db,
            device.household_id,
            device.device_id,
            photo_service.by_album(album_id),
            photo_id,
            person_id,
            emoji,
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _set_hidden(
    album_id: uuid.UUID, photo_id: uuid.UUID, account: Any, db: Any, hidden: bool
) -> Response:
    try:
        await photo_service.set_hidden(
            db,
            account.household_id,
            account.account_id,
            photo_service.by_album(album_id),
            photo_id,
            hidden=hidden,
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{album_id}/photos/{photo_id}/hide",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def hide_album_photo(
    album_id: uuid.UUID, photo_id: uuid.UUID, account: CanRun, db: AccountDb
) -> Response:
    return await _set_hidden(album_id, photo_id, account, db, hidden=True)


@router.post(
    "/{album_id}/photos/{photo_id}/unhide",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def unhide_album_photo(
    album_id: uuid.UUID, photo_id: uuid.UUID, account: CanRun, db: AccountDb
) -> Response:
    return await _set_hidden(album_id, photo_id, account, db, hidden=False)


@router.delete(
    "/{album_id}/photos/{photo_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def delete_album_photo(
    album_id: uuid.UUID,
    photo_id: uuid.UUID,
    account: CanDelete,
    db: AccountDb,
    storage: Storage,
) -> Response:
    """Hard delete (admins), as on the movie night's album."""
    try:
        await photo_service.delete(
            db,
            storage,
            account.household_id,
            account.account_id,
            photo_service.by_album(album_id),
            photo_id,
        )
    except ServiceError as err:
        _raise(err)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
