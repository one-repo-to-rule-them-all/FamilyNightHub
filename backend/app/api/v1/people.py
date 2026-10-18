"""Avatar grid, this device's people, PINs and profiles (ADR-0002, ADR-0014)."""

from __future__ import annotations

import uuid
from typing import Any, NoReturn

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.dependencies import (
    CsrfProtected,
    CurrentDevice,
    CurrentViewer,
    DeviceDb,
    ViewerDb,
)
from app.core.permissions import has_permission
from app.core.rate_limit import Budget, retry_after, spend
from app.domain import credentials
from app.schemas.admin import HelpCountOut, JoinLinkOut
from app.schemas.identity import (
    BindingOut,
    ClaimIn,
    DeviceOut,
    PersonOut,
    PinErrorOut,
    PinResetRequestOut,
    SelfCreateIn,
    SetPinIn,
    UpdateSelfIn,
)
from app.schemas.profile import (
    ProfileAlbumOut,
    ProfileMovieOut,
    ProfileNightOut,
    ProfileOut,
    ProfilePickOut,
    ProfileStatsOut,
)
from app.services import (
    device_admin_service,
    household_settings_service,
    people_service,
    profile_service,
)
from app.services.errors import (
    Conflict,
    Forbidden,
    Invalid,
    NotFound,
    PinLocked,
    WrongPin,
)

router = APIRouter(tags=["people"])

NOT_FOUND: dict[int | str, dict[str, Any]] = {404: {"description": "No such person"}}
PIN_CHECKED: dict[int | str, dict[str, Any]] = {
    **NOT_FOUND,
    403: {"model": PinErrorOut, "description": "Wrong PIN (counted; `attempts_left` remain)"},
    422: {"description": "A PIN is needed (first claim: choose one; switch: enter it)"},
    423: {"model": PinErrorOut, "description": "Locked after 5 wrong PINs until an admin resets"},
    429: {"description": "Too many wrong PINs from this phone; try again later"},
}


def pin_budget() -> Budget:
    """Wrong PINs per device, on top of the 5-strike lock per person."""
    return Budget("pin", settings.PIN_FAILURE_LIMIT, settings.PIN_FAILURE_WINDOW_SECONDS)


def self_create_budget() -> Budget:
    return Budget("self_create", settings.SELF_CREATE_LIMIT, settings.SELF_CREATE_WINDOW_SECONDS)


def _tiles(tiles: list[people_service.PersonTile]) -> list[PersonOut]:
    return [_tile(t) for t in tiles]


def _tile(t: people_service.PersonTile) -> PersonOut:
    return PersonOut(
        id=t.id,
        name=t.name,
        avatar_emoji=t.avatar_emoji,
        color=t.color,
        is_guest=t.is_guest,
        binding=t.binding,
        has_pin=t.has_pin,
        locked=t.locked,
        current=t.current,
        can_rename=t.can_rename,
        pin_reset=t.pin_reset,
    )


async def _pin_refused(
    request: Request, device_id: uuid.UUID, err: WrongPin | PinLocked
) -> JSONResponse:
    """Wrong PIN / locked as a *returned* response: the failure count (and the lock) were
    written in this request's transaction, and raising would roll them back."""
    await spend(pin_budget(), str(device_id))
    if isinstance(err, WrongPin):
        code, status_code, left = "wrong_pin", status.HTTP_403_FORBIDDEN, err.attempts_left
        tries = "try" if left == 1 else "tries"
        message = f"Wrong PIN. {left} {tries} left before {err.name} is locked."
    else:
        code, status_code, left = "pin_locked", status.HTTP_423_LOCKED, 0
        message = (
            f"{err.name} is locked after {credentials.PIN_MAX_ATTEMPTS} wrong PINs. "
            "Ask an admin to reset the PIN."
        )
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "code": code,
                "message": message,
                "request_id": getattr(request.state, "request_id", None),
                "attempts_left": left,
            }
        },
    )


async def _check_pin_budget(device_id: uuid.UUID) -> None:
    wait = await retry_after(pin_budget(), str(device_id))
    if wait is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many wrong PINs from this phone. Try again later.",
            headers={"Retry-After": str(wait)},
        )


def _raise(err: Exception) -> NoReturn:
    if isinstance(err, NotFound):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Person not found") from None
    if isinstance(err, Forbidden):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, err.reason or "This phone can't act as them"
        ) from None
    if isinstance(err, Invalid):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, err.reason) from None
    if isinstance(err, Conflict):
        raise HTTPException(status.HTTP_409_CONFLICT, err.reason) from None
    raise err


@router.get("/people", response_model=list[PersonOut])
async def list_people(device: CurrentDevice, db: DeviceDb) -> list[PersonOut]:
    return _tiles(await people_service.list_people(db, device.device_id))


@router.get("/devices/me", response_model=DeviceOut)
async def my_device(device: CurrentDevice, db: DeviceDb) -> DeviceOut:
    tiles = await people_service.list_people(db, device.device_id)
    mine = [t for t in tiles if t.binding in ("mine", "pending")]
    return DeviceOut(id=device.device_id, people=_tiles(mine))


@router.get(
    "/devices/me/join-link",
    response_model=JoinLinkOut,
    responses={403: {"description": "Only the TV or a host account reads the join link"}},
)
async def join_link(viewer: CurrentViewer, db: ViewerDb) -> JoinLinkOut:
    """The household's join slug and whether the QR should carry the night code, for the
    TV (`is_tv` device) or a signed-in host (`sessions:run`). Phones get 403: the slug is on
    the fridge anyway, but there is no reason to hand it out."""
    if viewer.device is not None:
        allowed = await household_settings_service.is_tv(db, viewer.device.device_id)
    else:
        allowed = has_permission(viewer.role or "", "sessions:run")
    if not allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the TV or a host can read this")
    s = await household_settings_service.get(db, viewer.household_id)
    return JoinLinkOut(join_slug=s.join_slug, qr_includes_night_code=s.qr_includes_night_code)


@router.get(
    "/devices/me/help-count",
    response_model=HelpCountOut,
    responses={403: {"description": "Only the TV reads this"}},
)
async def help_count(device: CurrentDevice, db: DeviceDb) -> HelpCountOut:
    """How many phones are waiting for a host to OK a person claim, and who the oldest one
    is for. The TV only. PIN resets are admin-only and never counted here."""
    if not await household_settings_service.is_tv(db, device.device_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the TV can read this")
    help = await device_admin_service.help_count(db)
    return HelpCountOut(count=help.count, first_name=help.first_name)


@router.post(
    "/devices/me/people",
    response_model=PersonOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses={
        409: {"description": "Name already taken"},
        429: {"description": "Too many new profiles from this phone"},
    },
)
async def create_self(body: SelfCreateIn, device: CurrentDevice, db: DeviceDb) -> PersonOut:
    """Make a new profile for whoever holds this phone: always a guest (an admin converts
    or merges it later), current on this phone, with its PIN set in the same request."""
    budget = self_create_budget()
    wait = await retry_after(budget, str(device.device_id))
    if wait is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many new profiles from this phone. Try again later.",
            headers={"Retry-After": str(wait)},
        )
    await spend(budget, str(device.device_id))
    try:
        tile = await people_service.create_self(
            db,
            device.household_id,
            device.device_id,
            name=body.name,
            avatar_emoji=body.avatar_emoji,
            color=body.color,
            pin=body.pin,
        )
    except Conflict as err:
        _raise(err)
    return _tile(tile)


@router.put(
    "/devices/me/people/{person_id}",
    response_model=BindingOut,
    dependencies=[CsrfProtected],
    responses=PIN_CHECKED,
)
async def bind_person(
    person_id: uuid.UUID,
    request: Request,
    device: CurrentDevice,
    db: DeviceDb,
    body: ClaimIn | None = None,
) -> BindingOut | JSONResponse:
    """Claim a person for this phone, or switch to one it already holds (ADR-0014). With
    their PIN (or a new one on a first claim) the binding is active and current; without
    one, a person this phone doesn't hold yet waits for a host (`pending`)."""
    pin = body.pin if body else None
    if pin is not None:
        await _check_pin_budget(device.device_id)
    try:
        result = await people_service.claim(
            db, device.household_id, device.device_id, person_id, pin
        )
    except (WrongPin, PinLocked) as err:
        return await _pin_refused(request, device.device_id, err)
    except (NotFound, Invalid) as err:
        _raise(err)
    return BindingOut(person_id=person_id, status=result.status, current=result.current)


@router.patch(
    "/devices/me/people/{person_id}",
    response_model=PersonOut,
    dependencies=[CsrfProtected],
    responses={
        **NOT_FOUND,
        403: {"description": "This phone isn't currently acting as them"},
        409: {"description": "Already renamed once, or the name is taken"},
        422: {"description": "No field given, or a bad name, emoji or colour"},
    },
)
async def update_self(
    person_id: uuid.UUID, body: UpdateSelfIn, device: CurrentDevice, db: DeviceDb
) -> PersonOut:
    """Change your own display name (once; after that only an admin can rename you) and/or
    your picture (`avatar_emoji`, `color`; any number of times). Only the fields sent change."""
    try:
        tile = await people_service.update_self(
            db,
            device.household_id,
            device.device_id,
            person_id,
            name=body.name,
            avatar_emoji=body.avatar_emoji,
            color=body.color,
        )
    except (NotFound, Forbidden, Conflict) as err:
        _raise(err)
    return _tile(tile)


@router.post(
    "/devices/me/people/{person_id}/pin",
    response_model=BindingOut,
    dependencies=[CsrfProtected],
    responses={**PIN_CHECKED, 403: {"description": "Not held by this phone, or wrong PIN"}},
)
async def set_pin(
    person_id: uuid.UUID, body: SetPinIn, request: Request, device: CurrentDevice, db: DeviceDb
) -> BindingOut | JSONResponse:
    """Set a first PIN for someone this phone holds (people from before PINs, or after an
    admin reset), or change it with `current_pin`. Makes them current on this phone."""
    if body.current_pin is not None:
        await _check_pin_budget(device.device_id)
    try:
        result = await people_service.set_pin(
            db,
            device.household_id,
            device.device_id,
            person_id,
            new_pin=body.new_pin,
            current_pin=body.current_pin,
        )
    except (WrongPin, PinLocked) as err:
        return await _pin_refused(request, device.device_id, err)
    except (NotFound, Forbidden, Invalid) as err:
        _raise(err)
    return BindingOut(person_id=person_id, status=result.status, current=result.current)


@router.post(
    "/devices/me/people/{person_id}/forgot-pin",
    response_model=PinResetRequestOut,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def forgot_pin(
    person_id: uuid.UUID, device: CurrentDevice, db: DeviceDb
) -> PinResetRequestOut:
    """Ask an admin to reset this person's PIN. Repeating it while a request is open returns
    that request."""
    try:
        reset = await people_service.forgot_pin(
            db, device.household_id, device.device_id, person_id
        )
    except NotFound as err:
        _raise(err)
    return PinResetRequestOut(
        id=reset.id,
        status=reset.status,  # validated by PinResetRequestOut
        requested_at=reset.requested_at,
    )


@router.delete(
    "/devices/me/people/{person_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
)
async def unbind_person(person_id: uuid.UUID, device: CurrentDevice, db: DeviceDb) -> None:
    await people_service.unbind(db, device.device_id, person_id)


@router.get("/people/{person_id}/profile", response_model=ProfileOut, responses=NOT_FOUND)
async def person_profile(person_id: uuid.UUID, db: ViewerDb) -> ProfileOut:
    """Any device or account of the household. Revealed nights only: no ballot is readable
    before the reveal (ADR-0006)."""
    try:
        p = await profile_service.profile(db, person_id)
    except NotFound as err:
        _raise(err)

    def movie(m: profile_service.Movie | None) -> ProfileMovieOut | None:
        if m is None:
            return None
        return ProfileMovieOut(id=m.id, title=m.title, year=m.year, poster_path=m.poster_path)

    return ProfileOut(
        id=p.id,
        name=p.name,
        avatar_emoji=p.avatar_emoji,
        color=p.color,
        is_guest=p.is_guest,
        created_at=p.created_at,
        stats=ProfileStatsOut(
            nights_joined=p.stats.nights_joined,
            ballots_cast=p.stats.ballots_cast,
            winners_picked=p.stats.winners_picked,
            ratings_given=p.stats.ratings_given,
            average_rating_given=p.stats.average_rating_given,
            photos_uploaded=p.stats.photos_uploaded,
        ),
        nights=[
            ProfileNightOut(
                session_id=n.session_id,
                title=n.title,
                status=n.status,  # validated: RESULT_STATUSES only
                voting_method=n.voting_method,
                date=n.date,
                winner=movie(n.winner),
                picks=[
                    ProfilePickOut(
                        option_id=pk.option_id,
                        rank=pk.rank,
                        movie=ProfileMovieOut(
                            id=pk.movie.id,
                            title=pk.movie.title,
                            year=pk.movie.year,
                            poster_path=pk.movie.poster_path,
                        ),
                    )
                    for pk in n.picks
                ],
                picked_winner=n.picked_winner,
                rating=n.rating,
                photo_count=n.photo_count,
            )
            for n in p.nights
        ],
        albums=[
            ProfileAlbumOut(
                session_id=a.session_id,
                title=a.title,
                photo_count=a.photo_count,
                photos_url=f"/api/v1/sessions/{a.session_id}/photos",
            )
            for a in p.albums
        ],
    )
