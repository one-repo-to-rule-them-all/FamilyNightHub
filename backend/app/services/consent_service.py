"""Terms, Privacy and parental consent (ADR-0017 §2).

Every account accepts the current Terms and Privacy Policy once per version. An admin also
confirms they are a parent or legal guardian of the children they add. The household's
**gate** is open while some admin's `guardian` acceptance names the current versions; until
then `require_household_consent` refuses anything that stores a child's data: new people,
new or revived devices, photos. Nights, votes and everything already stored keep working.

Rows are append-only (the migration revokes UPDATE and DELETE from `fnh_app`).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.legal import PRIVACY_VERSION, TERMS_VERSION
from app.services.errors import ConsentRequired, Invalid

STALE_VERSION = "The Terms or Privacy Policy changed. Reload the page and read the new version."
GUARDIAN_REQUIRED = "Admins confirm they're a parent or legal guardian of the children they add."


@dataclass(frozen=True)
class ConsentStatus:
    terms_version: str
    privacy_version: str
    # This account has accepted the current versions (as a guardian, if it's an admin).
    account_accepted: bool
    # The household's gate: some admin accepted the current versions as a guardian.
    household_accepted: bool


async def household_accepted(db: AsyncSession) -> bool:
    accepted: bool = await db.scalar(
        text(
            "SELECT EXISTS (SELECT 1 FROM household_consents WHERE role = 'admin' AND guardian "
            "AND terms_version = :t AND privacy_version = :p)"
        ),
        {"t": TERMS_VERSION, "p": PRIVACY_VERSION},
    )
    return accepted


async def require_household_consent(db: AsyncSession) -> None:
    """Raise ConsentRequired unless the request's household has passed the gate."""
    if not await household_accepted(db):
        raise ConsentRequired


async def status(db: AsyncSession, account_id: uuid.UUID, role: str) -> ConsentStatus:
    mine: bool = await db.scalar(
        text(
            "SELECT EXISTS (SELECT 1 FROM household_consents WHERE account_id = :a "
            "AND terms_version = :t AND privacy_version = :p AND (guardian OR :host))"
        ),
        {"a": account_id, "t": TERMS_VERSION, "p": PRIVACY_VERSION, "host": role != "admin"},
    )
    return ConsentStatus(TERMS_VERSION, PRIVACY_VERSION, mine, await household_accepted(db))


async def accept(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    role: str,
    *,
    terms_version: str,
    privacy_version: str,
    guardian: bool,
) -> ConsentStatus:
    """Record an acceptance of the versions the page showed. A stale page (the documents
    changed since it loaded) is refused, so nobody accepts text they didn't see."""
    if terms_version != TERMS_VERSION or privacy_version != PRIVACY_VERSION:
        raise Invalid(STALE_VERSION)
    if role == "admin" and not guardian:
        raise Invalid(GUARDIAN_REQUIRED)
    await db.execute(
        text(
            "INSERT INTO household_consents (household_id, account_id, role, terms_version, "
            "privacy_version, guardian) VALUES (:h, :a, :r, :t, :p, :g)"
        ),
        {
            "h": household_id,
            "a": account_id,
            "r": role,
            "t": terms_version,
            "p": privacy_version,
            "g": guardian and role == "admin",
        },
    )
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :a, 'consent.accepted', 'account', :a, "
            "jsonb_build_object('terms_version', CAST(:t AS text), "
            "'privacy_version', CAST(:p AS text), 'guardian', CAST(:g AS boolean)))"
        ),
        {
            "h": household_id,
            "a": account_id,
            "t": terms_version,
            "p": privacy_version,
            "g": guardian and role == "admin",
        },
    )
    return await status(db, account_id, role)
