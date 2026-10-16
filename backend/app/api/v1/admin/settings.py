"""Household settings and join-slug rotation (`admin:settings`)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.dependencies import AccountContext, AccountDb, CsrfProtected, require_permission
from app.schemas.admin import JoinSlugOut, SettingsOut, SettingsUpdateIn
from app.services import household_settings_service

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
    )


@router.get("/settings", response_model=SettingsOut)
async def get_settings(account: CanManageSettings, db: AccountDb) -> SettingsOut:
    return _out(await household_settings_service.get(db, account.household_id))


@router.patch("/settings", response_model=SettingsOut, dependencies=[CsrfProtected])
async def update_settings(
    body: SettingsUpdateIn, account: CanManageSettings, db: AccountDb
) -> SettingsOut:
    """Only the fields sent change. `default_voting_method` is `top3` until Phase 2;
    `default_age_cap: null` means no cap."""
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
