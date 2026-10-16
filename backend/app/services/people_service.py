"""Who-are-you: the avatar grid and binding people to devices (ADR-0002).

A device may act as several people (shared phone, "pass to next person"). Claiming a
person already actively bound to another live device creates a `pending` binding that a
host approves later; until then the device cannot act as that person.
`require_can_act_as` is the single check ballots, photos and ratings use.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.errors import Forbidden, NotFound

BindingState = Literal["mine", "pending", "taken", "free"]


@dataclass(frozen=True)
class PersonTile:
    id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    is_guest: bool
    binding: BindingState


# Bound to another *live* device (revoked devices free their people).
_BOUND_ELSEWHERE = """
    EXISTS (
        SELECT 1 FROM device_people dp JOIN devices d
          ON d.id = dp.device_id AND d.household_id = dp.household_id
        WHERE dp.person_id = p.id AND dp.device_id <> :device
          AND dp.status = 'active' AND d.revoked_at IS NULL
    )
"""


async def list_people(db: AsyncSession, device_id: uuid.UUID) -> list[PersonTile]:
    rows = await db.execute(
        text(
            f"""
            SELECT p.id, p.name, p.avatar_emoji, p.color, p.is_guest,
                   mine.status AS my_status, {_BOUND_ELSEWHERE} AS taken
            FROM people p
            LEFT JOIN device_people mine
              ON mine.person_id = p.id AND mine.device_id = :device
            WHERE p.merged_into_id IS NULL
            ORDER BY p.is_guest, lower(p.name)
            """
        ),
        {"device": device_id},
    )
    tiles = []
    for r in rows:
        binding: BindingState
        if r.my_status == "active":
            binding = "mine"
        elif r.my_status == "pending":
            binding = "pending"
        elif r.taken:
            binding = "taken"
        else:
            binding = "free"
        tiles.append(PersonTile(r.id, r.name, r.avatar_emoji, r.color, r.is_guest, binding))
    return tiles


async def bind(
    db: AsyncSession, household_id: uuid.UUID, device_id: uuid.UUID, person_id: uuid.UUID
) -> Literal["active", "pending"]:
    """Idempotent. Returns the binding's status."""
    person = (
        await db.execute(
            text(
                f"SELECT p.id, {_BOUND_ELSEWHERE} AS taken FROM people p "
                "WHERE p.id = :person AND p.merged_into_id IS NULL"
            ),
            {"person": person_id, "device": device_id},
        )
    ).first()
    if person is None:
        raise NotFound

    existing: str | None = await db.scalar(
        text("SELECT status FROM device_people WHERE device_id = :d AND person_id = :p"),
        {"d": device_id, "p": person_id},
    )
    if existing is not None:
        return "active" if existing == "active" else "pending"

    new_status: Literal["active", "pending"] = "pending" if person.taken else "active"
    await db.execute(
        text(
            "INSERT INTO device_people (household_id, device_id, person_id, status) "
            "VALUES (:h, :d, :p, :s)"
        ),
        {"h": household_id, "d": device_id, "p": person_id, "s": new_status},
    )
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_device_id, action, target_type, "
            "target_id, data) VALUES (:h, :d, 'person.bound', 'person', :p, "
            "jsonb_build_object('status', CAST(:s AS text)))"
        ),
        {"h": household_id, "d": device_id, "p": person_id, "s": new_status},
    )
    return new_status


async def unbind(db: AsyncSession, device_id: uuid.UUID, person_id: uuid.UUID) -> None:
    """Idempotent."""
    await db.execute(
        text("DELETE FROM device_people WHERE device_id = :d AND person_id = :p"),
        {"d": device_id, "p": person_id},
    )


async def can_act_as(db: AsyncSession, device_id: uuid.UUID, person_id: uuid.UUID) -> bool:
    found = await db.scalar(
        text(
            "SELECT 1 FROM device_people WHERE device_id = :d AND person_id = :p "
            "AND status = 'active'"
        ),
        {"d": device_id, "p": person_id},
    )
    return found is not None


async def require_can_act_as(db: AsyncSession, device_id: uuid.UUID, person_id: uuid.UUID) -> None:
    """ADR-0002: a device acts only as people actively bound to it (host proxy is separate)."""
    if not await can_act_as(db, device_id, person_id):
        raise Forbidden
