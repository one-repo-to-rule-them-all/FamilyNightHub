"""Join a household with the night code (ADR-0002).

The fridge QR's slug is a door, not a key: joining needs the code of a live night. A
successful join mints a device token (only its hash is stored) or, if the phone already
holds a live token for this household, reuses that device instead of piling up rows. A
token that went idle (issue #56, `device_idle`) is reused too, minus its people bindings.
The host-approved path (a signed-in host on the device) lands with magic-link auth.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import text

from app.core.database import AsyncSessionLocal, household_session
from app.core.dependencies import resolve_device_token
from app.core.security import hash_device_token, hash_night_code, new_token
from app.domain import night_code
from app.services import consent_service, device_idle
from app.services.errors import InvalidJoin


@dataclass(frozen=True)
class JoinResult:
    household_id: uuid.UUID
    household_name: str
    session_id: uuid.UUID
    device_id: uuid.UUID
    # Set only when a new device was minted; the caller must put it in the cookie.
    new_token: str | None


async def _household_for_slug(slug: str) -> uuid.UUID | None:
    async with AsyncSessionLocal() as session, session.begin():
        hid: uuid.UUID | None = await session.scalar(
            text("SELECT auth_resolve_household_by_slug(:s)"), {"s": slug}
        )
    return hid


async def join(
    slug: str, raw_code: str, *, existing_token: str | None, label: str | None
) -> JoinResult:
    code = night_code.normalize(raw_code)
    household_id = await _household_for_slug(slug) if code else None
    if code is None or household_id is None:
        raise InvalidJoin

    existing = await resolve_device_token(existing_token) if existing_token else None

    async with household_session(household_id) as db:
        session_id: uuid.UUID | None = await db.scalar(
            text(
                "SELECT id FROM sessions WHERE household_id = :h AND night_code_hash = :c "
                "AND status = ANY(:live)"
            ),
            {
                "h": household_id,
                "c": hash_night_code(code, household_id),
                "live": sorted(night_code.JOINABLE_STATUSES),
            },
        )
        if session_id is None:
            raise InvalidJoin

        token: str | None = None
        if existing is not None and existing[1] == household_id:
            device_id = existing[0]
            # Idle past DEVICE_IDLE_DAYS (issue #56): live again, people picked afresh.
            if await device_idle.revive_if_expired(db, device_id):
                await db.execute(
                    text(
                        "INSERT INTO audit_events (household_id, actor_device_id, action, "
                        "target_type, target_id, data) VALUES (:h, :d, 'device.rejoined', "
                        "'session', :s, '{}'::jsonb)"
                    ),
                    {"h": household_id, "d": device_id, "s": session_id},
                )
        else:
            # ADR-0017: no new phone until an admin has accepted the Terms as a guardian.
            await consent_service.require_household_consent(db)
            token = new_token()
            device_id = (
                await db.execute(
                    text(
                        "INSERT INTO devices (household_id, token_hash, label, last_seen_at) "
                        "VALUES (:h, :t, :l, now()) RETURNING id"
                    ),
                    {"h": household_id, "t": hash_device_token(token), "l": label},
                )
            ).scalar_one()
            await db.execute(
                text(
                    "INSERT INTO audit_events (household_id, actor_device_id, action, "
                    "target_type, target_id, data) VALUES (:h, :d, 'device.joined', "
                    "'session', :s, '{}'::jsonb)"
                ),
                {"h": household_id, "d": device_id, "s": session_id},
            )

        name: str = (
            await db.execute(text("SELECT name FROM households WHERE id = :h"), {"h": household_id})
        ).scalar_one()

    return JoinResult(
        household_id=household_id,
        household_name=name,
        session_id=session_id,
        device_id=device_id,
        new_token=token,
    )
