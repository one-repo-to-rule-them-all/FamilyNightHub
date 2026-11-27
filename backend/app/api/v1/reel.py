"""The night reel (ADR-0018 amendment "Night reel", 03-backend.md "Reel").

One read-only snapshot of the household's recent quotes, winners and photos in a seeded show
order, for the TV to cycle locally. Any device or account of the household may read it.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, Query

from app.api.v1.photos import photo_storage
from app.api.v1.sessions import tie_seed
from app.core.config import settings
from app.core.dependencies import CurrentViewer, ViewerDb
from app.integrations.storage import PhotoStorage
from app.schemas.reel import ReelOut
from app.services import reel_service

router = APIRouter(prefix="/reel", tags=["reel"])


@router.get("", response_model=ReelOut)
async def get_reel(
    viewer: CurrentViewer,
    db: ViewerDb,
    storage: Annotated[PhotoStorage | None, Depends(photo_storage)],
    window: Annotated[Literal["tonight", "all"], Query()] = "tonight",
    x_fnh_test_seed: Annotated[str | None, Header(alias="X-FNH-Test-Seed")] = None,
) -> ReelOut:
    """Quotes, winners, leaderboards and photos from `window` (the last 12 hours, or all
    time), in a stable seeded order. Hidden notes and photos never appear."""
    pinned = (
        tie_seed(x_fnh_test_seed)
        if x_fnh_test_seed is not None and settings.ENVIRONMENT == "test"
        else None
    )
    return await reel_service.build(db, storage, viewer.household_id, window=window, seed=pinned)
