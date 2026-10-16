"""History edit (`admin:history`): correct a past night's winner (ADR-0006: a re-close
with an audit row; the stored ranking and tie seed are never touched)."""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends

from app.api.v1.sessions import _out as session_out
from app.api.v1.sessions import raise_http
from app.core.dependencies import AccountContext, AccountDb, CsrfProtected, require_permission
from app.schemas.library import CorrectWinnerIn
from app.schemas.sessions import SessionOut
from app.services import session_service
from app.services.errors import ServiceError

router = APIRouter(prefix="/sessions", tags=["admin"])

CanEditHistory = Annotated[AccountContext, Depends(require_permission("admin:history"))]

RESPONSES: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such night in this household"},
    409: {
        "description": "The night has no winner yet, the option is not on its shortlist, or "
        "it is already the winner"
    },
}


@router.post(
    "/{session_id}/correct-winner",
    response_model=SessionOut,
    dependencies=[CsrfProtected],
    responses=RESPONSES,
)
async def correct_winner(
    session_id: uuid.UUID, body: CorrectWinnerIn, account: CanEditHistory, db: AccountDb
) -> SessionOut:
    """Make another option of the same night its winner, with a reason. Only for nights
    that are revealed, tonight or closed. Audited as `session.winner_corrected` with
    old/new and the reason. Returns the night's snapshot."""
    try:
        await session_service.correct_winner(
            db, account.household_id, account.account_id, session_id, body.option_id, body.reason
        )
    except ServiceError as err:
        raise_http(err)
    return await session_out(db, account.household_id, session_id)
