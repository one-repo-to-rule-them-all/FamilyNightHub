"""Household settings and join-slug rotation (`admin:settings`)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.v1.photos import photo_storage
from app.core.dependencies import AccountContext, AccountDb, CsrfProtected, require_permission
from app.integrations.storage import PhotoStorage
from app.schemas.admin import (
    JoinSlugOut,
    SettingsOut,
    SettingsUpdateIn,
    StartFreshIn,
    StartFreshOut,
)
from app.services import household_settings_service, removal_service
from app.services.errors import Invalid, Unavailable

router = APIRouter(tags=["admin"])

CanManageSettings = Annotated[AccountContext, Depends(require_permission("admin:settings"))]


def _out(s: household_settings_service.HouseholdSettings) -> SettingsOut:
    return SettingsOut(
        join_slug=s.join_slug,
        default_voting_method=s.default_voting_method,
        default_age_cap=s.default_age_cap,
        region=s.region,
        streaming_providers=s.streaming_providers,
        updated_at=s.updated_at,
        qr_includes_night_code=s.qr_includes_night_code,
    )


@router.get("/settings", response_model=SettingsOut)
async def get_settings(account: CanManageSettings, db: AccountDb) -> SettingsOut:
    return _out(await household_settings_service.get(db, account.household_id))


@router.patch("/settings", response_model=SettingsOut, dependencies=[CsrfProtected])
async def update_settings(
    body: SettingsUpdateIn, account: CanManageSettings, db: AccountDb
) -> SettingsOut:
    """Only the fields sent change. `default_voting_method` is what new nights start
    with; `default_age_cap: null` means no cap."""
    changes = body.model_dump(include=body.model_fields_set)
    # null is meaningful only for the age cap; elsewhere it means "unchanged".
    changes = {k: v for k, v in changes.items() if v is not None or k == "default_age_cap"}
    return _out(
        await household_settings_service.update(
            db, account.household_id, account.account_id, changes
        )
    )


@router.post("/join-slug/rotate", response_model=JoinSlugOut, dependencies=[CsrfProtected])
async def rotate_join_slug(account: CanManageSettings, db: AccountDb) -> JoinSlugOut:
    """New fridge-QR slug; `/j/{old}` stops resolving immediately. Reprint the QR."""
    slug = await household_settings_service.rotate_join_slug(
        db, account.household_id, account.account_id
    )
    return JoinSlugOut(join_slug=slug)


@router.post(
    "/start-fresh",
    response_model=StartFreshOut,
    dependencies=[CsrfProtected],
    responses={
        422: {"description": "The typed family name doesn't match"},
        503: {"description": "Photos can't be deleted right now"},
    },
)
async def start_fresh(
    body: StartFreshIn,
    account: CanManageSettings,
    db: AccountDb,
    storage: Annotated[PhotoStorage | None, Depends(photo_storage)],
) -> StartFreshOut:
    """Clear every person, phone/TV and night (with their votes, ratings, attendance and
    photos). The household, accounts, settings and movie library stay. The admin types the
    family name to confirm. Audited. Can't be undone (issue #94)."""
    try:
        c = await removal_service.start_fresh(
            db, storage, account.household_id, account.account_id, body.confirm_name
        )
    except Invalid as err:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, err.reason) from None
    except Unavailable as err:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, err.reason) from None
    return StartFreshOut(people=c.people, phones=c.phones, nights=c.nights, photos=c.photos)
