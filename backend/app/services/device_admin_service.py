"""Host-side device control (ADR-0002): enrolling a phone without the night code, pairing
the TV, and approving or rejecting claims on people already bound to another phone.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_device_token, new_token
from app.services.errors import NotFound


@dataclass(frozen=True)
class Enrolled:
    device_id: uuid.UUID
    is_tv: bool
    # Set only when a new device was minted; the caller must put it in the cookie.
    new_token: str | None


@dataclass(frozen=True)
class PendingClaim:
    device_id: uuid.UUID
    device_label: str | None
    person_id: uuid.UUID
    person_name: str
    avatar_emoji: str
    requested_at: datetime


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    action: str,
    target_type: str,
    target_id: uuid.UUID,
) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id) VALUES (:h, :a, :action, :tt, :t)"
        ),
        {"h": household_id, "a": account_id, "action": action, "tt": target_type, "t": target_id},
    )


async def enroll(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    existing_device_id: uuid.UUID | None,
    label: str | None,
    as_tv: bool,
) -> Enrolled:
    """Let this browser in on the host's authority. `existing_device_id` is a live device
    of *this* household already held by the browser (resolved by the caller); it is reused
    rather than duplicated."""
    if existing_device_id is not None:
        await db.execute(
            text(
                "UPDATE devices SET is_tv = is_tv OR :tv, label = COALESCE(:l, label), "
                "last_seen_at = now() WHERE id = :d"
            ),
            {"tv": as_tv, "l": label, "d": existing_device_id},
        )
        is_tv: bool = (
            await db.execute(
                text("SELECT is_tv FROM devices WHERE id = :d"), {"d": existing_device_id}
            )
        ).scalar_one()
        await _audit(db, household_id, account_id, "device.enrolled", "device", existing_device_id)
        return Enrolled(existing_device_id, is_tv, None)

    token = new_token()
    device_id: uuid.UUID = (
        await db.execute(
            text(
                "INSERT INTO devices (household_id, token_hash, label, is_tv, last_seen_at) "
                "VALUES (:h, :t, :l, :tv, now()) RETURNING id"
            ),
            {"h": household_id, "t": hash_device_token(token), "l": label, "tv": as_tv},
        )
    ).scalar_one()
    await _audit(db, household_id, account_id, "device.enrolled", "device", device_id)
    return Enrolled(device_id, as_tv, token)


async def pending_claims(db: AsyncSession) -> list[PendingClaim]:
    rows = await db.execute(
        text(
            """
            SELECT dp.device_id, d.label AS device_label, p.id AS person_id,
                   p.name AS person_name, p.avatar_emoji, dp.created_at AS requested_at
            FROM device_people dp
            JOIN devices d ON d.id = dp.device_id AND d.household_id = dp.household_id
            JOIN people p ON p.id = dp.person_id AND p.household_id = dp.household_id
            WHERE dp.status = 'pending' AND d.revoked_at IS NULL
            ORDER BY dp.created_at
            """
        )
    )
    return [
        PendingClaim(
            r.device_id, r.device_label, r.person_id, r.person_name, r.avatar_emoji, r.requested_at
        )
        for r in rows
    ]


async def approve_claim(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
) -> None:
    """Pending -> active. The person stays bound to their other phone too (a parent's phone
    and a kid's tablet can both act as the kid)."""
    updated = await db.execute(
        text(
            "UPDATE device_people SET status = 'active' WHERE device_id = :d AND person_id = :p "
            "AND status = 'pending' RETURNING id"
        ),
        {"d": device_id, "p": person_id},
    )
    if updated.first() is None:
        raise NotFound
    await _audit(db, household_id, account_id, "claim.approved", "person", person_id)


async def reject_claim(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
) -> None:
    deleted = await db.execute(
        text(
            "DELETE FROM device_people WHERE device_id = :d AND person_id = :p "
            "AND status = 'pending' RETURNING id"
        ),
        {"d": device_id, "p": person_id},
    )
    if deleted.first() is None:
        raise NotFound
    await _audit(db, household_id, account_id, "claim.rejected", "person", person_id)
