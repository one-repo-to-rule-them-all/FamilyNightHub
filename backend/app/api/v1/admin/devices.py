"""The admin "Devices" list: label and revoke (`admin:devices`, ADR-0002).

Revocation is final. There is no un-revoke: a revoked phone rejoins with a night code
(or a host enrollment) and becomes a new device.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.dependencies import AccountContext, AccountDb, CsrfProtected, require_permission
from app.schemas.admin import AdminDeviceOut, DeviceBindingOut, DeviceUpdateIn
from app.services import device_admin_service
from app.services.errors import NotFound

router = APIRouter(prefix="/devices", tags=["admin"])

CanManageDevices = Annotated[AccountContext, Depends(require_permission("admin:devices"))]

NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such device in this household"}
}


def _out(d: device_admin_service.DeviceSummary) -> AdminDeviceOut:
    return AdminDeviceOut(
        id=d.id,
        label=d.label,
        is_tv=d.is_tv,
        last_seen_at=d.last_seen_at,
        revoked_at=d.revoked_at,
        created_at=d.created_at,
        expired=d.expired,
        people=[
            DeviceBindingOut(
                person_id=b.person_id,
                name=b.name,
                avatar_emoji=b.avatar_emoji,
                status=b.status,
            )
            for b in d.people
        ],
    )


@router.get("", response_model=list[AdminDeviceOut])
async def list_devices(account: CanManageDevices, db: AccountDb) -> list[AdminDeviceOut]:
    """Every device, live first (most recently seen first), then revoked."""
    return [_out(d) for d in await device_admin_service.list_devices(db)]


@router.patch(
    "/{device_id}",
    response_model=AdminDeviceOut,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def update_device(
    device_id: uuid.UUID, body: DeviceUpdateIn, account: CanManageDevices, db: AccountDb
) -> AdminDeviceOut:
    """Set or clear (`null`) the label."""
    try:
        device = await device_admin_service.set_label(
            db, account.household_id, account.account_id, device_id, body.label
        )
    except NotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found") from None
    return _out(device)


@router.post(
    "/{device_id}/revoke",
    response_model=AdminDeviceOut,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def revoke_device(
    device_id: uuid.UUID, account: CanManageDevices, db: AccountDb
) -> AdminDeviceOut:
    """Its cookie stops working on the next request and its people become free to claim.
    Idempotent and final."""
    try:
        device = await device_admin_service.revoke(
            db, account.household_id, account.account_id, device_id
        )
    except NotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found") from None
    return _out(device)
