"""GET /api/health: gates deploys and the uptime monitor (02-environments.md).

Checks the database *through the RLS path* (app role, GUC set for a sentinel household)
plus a Redis ping. Returns 503 with per-dependency status when either is down, so Fly
holds back a deploy whose machines cannot reach their data plane.
"""

from __future__ import annotations

import uuid
from typing import Literal

import structlog
from fastapi import APIRouter, Response
from pydantic import BaseModel
from sqlalchemy import text

from app.core.config import settings
from app.core.database import household_session
from app.core.redis import get_redis

router = APIRouter(tags=["meta"])
log = structlog.get_logger()

# No household has this id; the check proves the GUC round-trip, not data access.
SENTINEL_HOUSEHOLD_ID = uuid.UUID(int=0)

CheckStatus = Literal["ok", "error"]


class HealthOut(BaseModel):
    status: CheckStatus
    environment: str
    database: CheckStatus
    redis: CheckStatus


async def _check_database() -> CheckStatus:
    try:
        async with household_session(SENTINEL_HOUSEHOLD_ID) as session:
            guc = await session.scalar(text("SELECT current_setting('app.household_id', true)"))
        return "ok" if guc == str(SENTINEL_HOUSEHOLD_ID) else "error"
    except Exception:
        log.warning("health_database_failed", exc_info=True)
        return "error"


async def _check_redis() -> CheckStatus:
    try:
        await get_redis().ping()
        return "ok"
    except Exception:
        log.warning("health_redis_failed", exc_info=True)
        return "error"


@router.get("/api/health", response_model=HealthOut)
async def health(response: Response) -> HealthOut:
    database = await _check_database()
    redis = await _check_redis()
    overall: CheckStatus = "ok" if database == redis == "ok" else "error"
    if overall != "ok":
        response.status_code = 503
    return HealthOut(
        status=overall, environment=settings.ENVIRONMENT, database=database, redis=redis
    )
