"""Add, edit, convert and merge people (`admin:people`; hosts may add guests)."""

from __future__ import annotations

import uuid
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.v1.photos import photo_storage
from app.core.dependencies import (
    AccountContext,
    AccountDb,
    CsrfProtected,
    CurrentAccount,
    require_permission,
)
from app.core.permissions import has_permission
from app.integrations.storage import PhotoStorage
from app.schemas.admin import (
    AdminPersonOut,
    MergeIn,
    MergeOut,
    PersonCreateIn,
    PersonUpdateIn,
    RemovalOut,
)
from app.services import people_admin_service, removal_service
from app.services.errors import Conflict, NotFound, ServiceError, Unavailable

router = APIRouter(prefix="/people", tags=["admin"])

CanManagePeople = Annotated[AccountContext, Depends(require_permission("admin:people"))]

NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such (unmerged) person in this household"}
}
CONFLICT: dict[int | str, dict[str, Any]] = {
    409: {"description": "Name already taken, or merging a person into themselves"}
}


def _raise(err: ServiceError) -> NoReturn:
    if isinstance(err, NotFound):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Person not found") from None
    if isinstance(err, Conflict):
        raise HTTPException(status.HTTP_409_CONFLICT, err.reason) from None
    if isinstance(err, Unavailable):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, err.reason) from None
    raise err  # pragma: no cover


def _out(p: people_admin_service.Person) -> AdminPersonOut:
    return AdminPersonOut(
        id=p.id,
        name=p.name,
        avatar_emoji=p.avatar_emoji,
        color=p.color,
        is_guest=p.is_guest,
        created_at=p.created_at,
        has_pin=p.has_pin,
        locked=p.locked,
    )


@router.get("", response_model=list[AdminPersonOut])
async def list_people(
    account: CanManagePeople, db: AccountDb, guests_only: bool = False
) -> list[AdminPersonOut]:
    """Everyone not merged away; `guests_only` for the "convert a guest" list."""
    return [_out(p) for p in await people_admin_service.list_people(db, guests_only=guests_only)]


@router.post(
    "",
    response_model=AdminPersonOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses={403: {"description": "Hosts may only add guests"}, **CONFLICT},
)
async def create_person(
    body: PersonCreateIn, account: CurrentAccount, db: AccountDb
) -> AdminPersonOut:
    """Admins add anyone. A host running nights (`sessions:run`) may add a guest."""
    allowed = has_permission(account.role, "admin:people") or (
        body.is_guest and has_permission(account.role, "sessions:run")
    )
    if not allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed for your role")
    try:
        person = await people_admin_service.create(
            db,
            account.household_id,
            account.account_id,
            name=body.name,
            avatar_emoji=body.avatar_emoji,
            color=body.color,
            is_guest=body.is_guest,
        )
    except ServiceError as err:
        _raise(err)
    return _out(person)


@router.post(
    "/merge",
    response_model=MergeOut,
    dependencies=[CsrfProtected],
    responses={**NOT_FOUND, **CONFLICT},
)
async def merge_people(body: MergeIn, account: CanManagePeople, db: AccountDb) -> MergeOut:
    """Fold one person into another; the source is kept with `merged_into_id` set and
    disappears from every list. Collision rules: 03-backend.md "People admin"."""
    try:
        r = await people_admin_service.merge(
            db,
            account.household_id,
            account.account_id,
            from_person_id=body.from_person_id,
            into_person_id=body.into_person_id,
        )
    except ServiceError as err:
        _raise(err)
    return MergeOut(
        person=_out(r.person),
        merged_from_id=r.merged_from_id,
        ballot_ranks_moved=r.ballot_ranks_moved,
        ballot_ranks_dropped=r.ballot_ranks_dropped,
        ratings_moved=r.ratings_moved,
        ratings_dropped=r.ratings_dropped,
        photos_moved=r.photos_moved,
        reactions_moved=r.reactions_moved,
        reactions_dropped=r.reactions_dropped,
        bindings_moved=r.bindings_moved,
        bindings_dropped=r.bindings_dropped,
    )


@router.patch(
    "/{person_id}",
    response_model=AdminPersonOut,
    dependencies=[CsrfProtected],
    responses={**NOT_FOUND, **CONFLICT},
)
async def update_person(
    person_id: uuid.UUID, body: PersonUpdateIn, account: CanManagePeople, db: AccountDb
) -> AdminPersonOut:
    """Rename / re-avatar / recolour; fields left out are unchanged."""
    try:
        person = await people_admin_service.update(
            db,
            account.household_id,
            account.account_id,
            person_id,
            name=body.name,
            avatar_emoji=body.avatar_emoji,
            color=body.color,
        )
    except ServiceError as err:
        _raise(err)
    return _out(person)


@router.post(
    "/{person_id}/convert-to-member",
    response_model=AdminPersonOut,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def convert_to_member(
    person_id: uuid.UUID, account: CanManagePeople, db: AccountDb
) -> AdminPersonOut:
    """A guest becomes a family member (`is_guest = false`). Idempotent."""
    try:
        person = await people_admin_service.convert_to_member(
            db, account.household_id, account.account_id, person_id
        )
    except ServiceError as err:
        _raise(err)
    return _out(person)


@router.post(
    "/{person_id}/reset-pin",
    response_model=AdminPersonOut,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def reset_pin(
    person_id: uuid.UUID, account: CanManagePeople, db: AccountDb
) -> AdminPersonOut:
    """Clear the person's PIN, failure count and lock, locked or not, and close any open
    forgot-PIN request as approved. No PIN is set or revealed: the person chooses a new one
    on their phone."""
    try:
        person = await people_admin_service.reset_pin(
            db, account.household_id, account.account_id, person_id
        )
    except ServiceError as err:
        _raise(err)
    return _out(person)


def _removal(c: removal_service.RemovalCounts) -> RemovalOut:
    return RemovalOut(
        nights_voted=c.nights_voted,
        ratings=c.ratings,
        photos=c.photos,
        reactions=c.reactions,
        phones=c.phones,
    )


@router.get("/{person_id}/removal", response_model=RemovalOut, responses=NOT_FOUND)
async def removal_preview(
    person_id: uuid.UUID, account: CanManagePeople, db: AccountDb
) -> RemovalOut:
    """What removing this person would delete, for the confirm dialog."""
    try:
        return _removal(await removal_service.removal_preview(db, person_id))
    except ServiceError as err:
        _raise(err)


@router.delete(
    "/{person_id}",
    response_model=RemovalOut,
    dependencies=[CsrfProtected],
    responses={**NOT_FOUND, 503: {"description": "Their photos can't be deleted right now"}},
)
async def remove_person(
    person_id: uuid.UUID,
    account: CanManagePeople,
    db: AccountDb,
    storage: Annotated[PhotoStorage | None, Depends(photo_storage)],
) -> RemovalOut:
    """Delete a person and everything that is theirs: phone links, PIN requests, attendance,
    votes, ratings, reactions and the photos they shared (issue #94). A night keeps its
    winner. Audited. Can't be undone."""
    try:
        counts = await removal_service.remove_person(
            db, storage, account.household_id, account.account_id, person_id
        )
    except ServiceError as err:
        _raise(err)
    return _removal(counts)
