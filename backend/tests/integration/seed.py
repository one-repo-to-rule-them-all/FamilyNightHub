"""Seed one household with at least one row in every household-scoped table.

Inserts go through `fnh_app` with the household GUC set, i.e. through RLS `WITH CHECK`, so
the seed itself proves a household can write its own rows. Raw SQL on purpose: the tests
must not depend on service code that does not exist yet.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import household_session
from app.domain.legal import PRIVACY_VERSION, TERMS_VERSION


@dataclass
class SeededHousehold:
    household_id: uuid.UUID
    slug: str
    device_token_hash: str
    magic_link_token_hash: str
    account_email: str
    ids: dict[str, uuid.UUID] = field(default_factory=dict)


async def _insert(session: AsyncSession, table: str, **values: Any) -> uuid.UUID:
    cols = ", ".join(values)
    params = ", ".join(f":{k}" for k in values)
    returning = "household_id" if table == "settings" else "id"
    row = await session.execute(
        text(f"INSERT INTO {table} ({cols}) VALUES ({params}) RETURNING {returning}"), values
    )
    result: uuid.UUID = row.scalar_one()
    return result


async def seed_household(tag: str) -> SeededHousehold:
    hid = uuid.uuid4()
    nonce = uuid.uuid4().hex
    seeded = SeededHousehold(
        household_id=hid,
        slug=f"fam-{tag}-{nonce[:12]}",
        device_token_hash=f"dev{nonce}",
        magic_link_token_hash=f"ml{nonce}",
        account_email=f"Host.{tag}.{nonce[:8]}@Example.test",
    )
    ids = seeded.ids
    now = datetime.now(UTC)

    async with household_session(hid) as s:
        await _insert(s, "households", id=hid, name=f"Family {tag}", join_slug=seeded.slug)
        await _insert(s, "settings", household_id=hid)
        ids["account"] = await _insert(
            s,
            "accounts",
            household_id=hid,
            email=seeded.account_email,
            display_name="Host",
            role="admin",
        )
        ids["magic_link"] = await _insert(
            s,
            "magic_links",
            household_id=hid,
            account_id=ids["account"],
            token_hash=seeded.magic_link_token_hash,
            expires_at=now + timedelta(minutes=15),
        )
        ids["person"] = await _insert(
            s, "people", household_id=hid, name="Kid", avatar_emoji="🦖", color="#f59e0b"
        )
        ids["device"] = await _insert(
            s, "devices", household_id=hid, token_hash=seeded.device_token_hash
        )
        ids["device_person"] = await _insert(
            s, "device_people", household_id=hid, device_id=ids["device"], person_id=ids["person"]
        )
        ids["movie"] = await _insert(s, "movies", household_id=hid, title="Paddington", tmdb_id=1)
        ids["movie2"] = await _insert(s, "movies", household_id=hid, title="Up", tmdb_id=2)
        ids["session"] = await _insert(
            s,
            "sessions",
            household_id=hid,
            night_code_hash=f"nc{nonce}",
            host_account_id=ids["account"],
        )
        ids["option"] = await _insert(
            s, "options", household_id=hid, session_id=ids["session"], movie_id=ids["movie"]
        )
        ids["option2"] = await _insert(
            s, "options", household_id=hid, session_id=ids["session"], movie_id=ids["movie2"]
        )
        ids["ballot_rank"] = await _insert(
            s,
            "ballot_ranks",
            household_id=hid,
            session_id=ids["session"],
            person_id=ids["person"],
            option_id=ids["option"],
            rank=1,
            cast_by_device_id=ids["device"],
        )
        ids["rating"] = await _insert(
            s,
            "ratings",
            household_id=hid,
            session_id=ids["session"],
            person_id=ids["person"],
            score=5,
        )
        photo_key = f"households/{hid}/sessions/{ids['session']}/{nonce}"
        ids["photo"] = await _insert(
            s,
            "photos",
            household_id=hid,
            session_id=ids["session"],
            person_id=ids["person"],
            object_key=f"{photo_key}.jpg",
            thumb_key=f"{photo_key}_thumb.jpg",
        )
        ids["photo_reaction"] = await _insert(
            s,
            "photo_reactions",
            household_id=hid,
            photo_id=ids["photo"],
            person_id=ids["person"],
            emoji="❤️",
        )
        ids["photo_deletion"] = await _insert(
            s,
            "photo_deletions",
            household_id=hid,
            photo_id=uuid.uuid4(),
            object_key="gone.jpg",
            thumb_key="gone_thumb.jpg",
        )
        ids["pin_reset_request"] = await _insert(
            s,
            "pin_reset_requests",
            household_id=hid,
            person_id=ids["person"],
            requested_by_device_id=ids["device"],
        )
        ids["session_attendance"] = await _insert(
            s,
            "session_attendance",
            household_id=hid,
            session_id=ids["session"],
            person_id=ids["person"],
        )
        # ADR-0017: an admin's guardian acceptance of the current versions opens the gate.
        ids["household_consent"] = await _insert(
            s,
            "household_consents",
            household_id=hid,
            account_id=ids["account"],
            role="admin",
            terms_version=TERMS_VERSION,
            privacy_version=PRIVACY_VERSION,
            guardian=True,
        )
        ids["audit_event"] = await _insert(
            s, "audit_events", household_id=hid, action="seed", target_type="household"
        )
    return seeded
