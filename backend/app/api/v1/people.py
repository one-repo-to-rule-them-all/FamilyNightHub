"""Avatar grid and this device's people (ADR-0002)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status

from app.core.dependencies import CsrfProtected, CurrentDevice, DeviceDb
from app.schemas.identity import BindingOut, DeviceOut, PersonOut
from app.services import people_service
from app.services.errors import NotFound

router = APIRouter(tags=["people"])


def _tiles(tiles: list[people_service.PersonTile]) -> list[PersonOut]:
    return [
        PersonOut(
            id=t.id,
            name=t.name,
            avatar_emoji=t.avatar_emoji,
            color=t.color,
            is_guest=t.is_guest,
            binding=t.binding,
        )
        for t in tiles
    ]


@router.get("/people", response_model=list[PersonOut])
async def list_people(device: CurrentDevice, db: DeviceDb) -> list[PersonOut]:
    return _tiles(await people_service.list_people(db, device.device_id))


@router.get("/devices/me", response_model=DeviceOut)
async def my_device(device: CurrentDevice, db: DeviceDb) -> DeviceOut:
    tiles = await people_service.list_people(db, device.device_id)
    mine = [t for t in tiles if t.binding in ("mine", "pending")]
    return DeviceOut(id=device.device_id, people=_tiles(mine))


@router.put(
    "/devices/me/people/{person_id}",
    response_model=BindingOut,
    dependencies=[CsrfProtected],
    responses={404: {"description": "No such person in this household"}},
)
async def bind_person(person_id: uuid.UUID, device: CurrentDevice, db: DeviceDb) -> BindingOut:
    try:
        state = await people_service.bind(db, device.household_id, device.device_id, person_id)
    except NotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Person not found") from None
    return BindingOut(person_id=person_id, status=state)


@router.delete(
    "/devices/me/people/{person_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
)
async def unbind_person(person_id: uuid.UUID, device: CurrentDevice, db: DeviceDb) -> None:
    await people_service.unbind(db, device.device_id, person_id)
