"""Household settings and the join slug (ADR-0002: admins rotate the slug).

Rotating the slug retires the fridge QR at once: `/j/{old}` stops resolving because the
ADR-0009 slug resolver only knows the current value. Devices already in keep working.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import join_slug

_SLUG_ATTEMPTS = 5


@dataclass(frozen=True)
class HouseholdSettings:
    join_slug: str
    default_voting_method: str
    default_age_cap: str | None
    region: str
    streaming_providers: list[int]
    updated_at: datetime


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    action: str,
    data: dict[str, Any],
) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :a, :action, 'household', :h, CAST(:data AS jsonb))"
        ),
        {"h": household_id, "a": account_id, "action": action, "data": json.dumps(data)},
    )


async def get(db: AsyncSession, household_id: uuid.UUID) -> HouseholdSettings:
    # Bootstrap writes the row; this keeps a household seeded without one readable.
    await db.execute(
        text("INSERT INTO settings (household_id) VALUES (:h) ON CONFLICT DO NOTHING"),
        {"h": household_id},
    )
    row = (
        await db.execute(
            text(
                "SELECT h.join_slug, s.default_voting_method, s.default_age_cap, s.region, "
                "s.streaming_providers, s.updated_at "
                "FROM households h JOIN settings s ON s.household_id = h.id WHERE h.id = :h"
            ),
            {"h": household_id},
        )
    ).one()
    return HouseholdSettings(
        row.join_slug,
        row.default_voting_method,
        row.default_age_cap,
        row.region,
        list(row.streaming_providers or []),
        row.updated_at,
    )


async def update(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    changes: dict[str, Any],
) -> HouseholdSettings:
    """`changes` holds only the fields the caller sent (None clears `default_age_cap`).
    Column names come from this fixed allow-list, never from the request."""
    allowed = ("default_voting_method", "default_age_cap", "region", "streaming_providers")
    fields = {k: v for k, v in changes.items() if k in allowed}
    current = await get(db, household_id)
    if fields:
        assignments = ", ".join(f"{k} = :{k}" for k in fields)
        await db.execute(
            text(f"UPDATE settings SET {assignments}, updated_at = now() WHERE household_id = :h"),
            {**fields, "h": household_id},
        )
        before = {k: getattr(current, k) for k in fields}
        await _audit(
            db, household_id, account_id, "settings.updated", {"from": before, "to": fields}
        )
    return await get(db, household_id)


async def rotate_join_slug(db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID) -> str:
    for attempt in range(_SLUG_ATTEMPTS):
        slug = join_slug.generate()
        try:
            async with db.begin_nested():
                await db.execute(
                    text("UPDATE households SET join_slug = :s WHERE id = :h"),
                    {"s": slug, "h": household_id},
                )
        except IntegrityError:
            if attempt == _SLUG_ATTEMPTS - 1:
                raise
            continue
        # The slug itself is not secret (it's on the fridge), but it isn't history either.
        await _audit(db, household_id, account_id, "household.join_slug_rotated", {})
        return slug
    raise AssertionError("unreachable")  # pragma: no cover
