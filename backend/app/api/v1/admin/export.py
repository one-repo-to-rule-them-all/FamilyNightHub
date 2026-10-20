"""Download everything the household holds (ADR-0017 §4), `admin:settings`."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.v1.photos import photo_storage
from app.core.dependencies import AccountContext, AccountDb, require_permission
from app.integrations.storage import PhotoStorage
from app.services import export_service

router = APIRouter(prefix="/export", tags=["admin"])

CanExport = Annotated[AccountContext, Depends(require_permission("admin:settings"))]


@router.get(
    "",
    response_class=StreamingResponse,
    responses={200: {"content": {"application/zip": {}}, "description": "The export zip"}},
)
async def export(
    account: CanExport,
    db: AccountDb,
    storage: Annotated[PhotoStorage | None, Depends(photo_storage)],
) -> StreamingResponse:
    """A zip of every table (credential hashes removed) and every photo original. The rows
    are read, and the export audited, before the first byte goes out; photos stream after."""
    collected = await export_service.collect(db, account.household_id, account.account_id)
    return StreamingResponse(
        export_service.stream_zip(collected, storage),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{collected.filename}"',
            "Cache-Control": "no-store",
        },
    )
