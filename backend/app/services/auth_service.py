"""Magic-link sign-in for hosts and admins (ADR-0002). Members never have accounts.

Links are 256-bit, stored only as a peppered hash, valid for MAGIC_LINK_TTL_MINUTES and
single-use. Consumption is an `UPDATE ... WHERE used_at IS NULL RETURNING`, so two tabs
racing the same link cannot both sign in.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal, household_session
from app.core.security import hash_magic_link_token, new_token
from app.integrations.email import Email
from app.services.errors import ServiceError


class InvalidLink(ServiceError):
    """Unknown, expired, already used, or the account is disabled: one answer for all."""


@dataclass(frozen=True)
class SignedIn:
    account_id: uuid.UUID
    household_id: uuid.UUID


@dataclass(frozen=True)
class AccountSummary:
    id: uuid.UUID
    email: str
    display_name: str
    role: str
    household_name: str


async def account_summary(db: AsyncSession, account_id: uuid.UUID) -> AccountSummary:
    row = (
        await db.execute(
            text(
                "SELECT a.id, a.email, a.display_name, a.role, h.name AS household_name "
                "FROM accounts a JOIN households h ON h.id = a.household_id WHERE a.id = :a"
            ),
            {"a": account_id},
        )
    ).one()
    return AccountSummary(row.id, row.email, row.display_name, row.role, row.household_name)


def normalize_email(email: str) -> str:
    return email.strip().lower()


async def request_magic_link(email: str) -> Email | None:
    """The email to send, or None when no live account has this address. The caller answers
    the same way in both cases."""
    async with AsyncSessionLocal() as session, session.begin():
        found = (
            await session.execute(
                text("SELECT account_id, household_id FROM auth_resolve_account_by_email(:e)"),
                {"e": normalize_email(email)},
            )
        ).first()
    if found is None:
        return None

    token = new_token()
    async with household_session(found.household_id) as db:
        recipient: str = (
            await db.execute(
                text("SELECT email FROM accounts WHERE id = :a"), {"a": found.account_id}
            )
        ).scalar_one()
        await db.execute(
            text(
                "INSERT INTO magic_links (household_id, account_id, token_hash, expires_at) "
                "VALUES (:h, :a, :t, :exp)"
            ),
            {
                "h": found.household_id,
                "a": found.account_id,
                "t": hash_magic_link_token(token),
                "exp": datetime.now(UTC) + timedelta(minutes=settings.MAGIC_LINK_TTL_MINUTES),
            },
        )

    link = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/auth/callback?token={token}"
    return Email(
        to=recipient,
        subject="Your Family Night sign-in link",
        text=(
            f"Tap to sign in to Family Night:\n\n{link}\n\n"
            f"The link works once and expires in {settings.MAGIC_LINK_TTL_MINUTES} minutes. "
            "If you didn't ask for it, you can ignore this email."
        ),
    )


async def verify_magic_link(token: str) -> SignedIn:
    async with AsyncSessionLocal() as session, session.begin():
        found = (
            await session.execute(
                text(
                    "SELECT magic_link_id, account_id, household_id "
                    "FROM auth_resolve_magic_link(:t)"
                ),
                {"t": hash_magic_link_token(token)},
            )
        ).first()
    if found is None:
        raise InvalidLink

    async with household_session(found.household_id) as db:
        consumed = (
            await db.execute(
                text(
                    "UPDATE magic_links SET used_at = now() "
                    "WHERE id = :m AND used_at IS NULL AND expires_at > now() "
                    "RETURNING account_id"
                ),
                {"m": found.magic_link_id},
            )
        ).first()
        if consumed is None:
            raise InvalidLink
        await db.execute(
            text(
                "INSERT INTO audit_events (household_id, actor_account_id, action, "
                "target_type, target_id) VALUES (:h, :a, 'account.signed_in', 'account', :a)"
            ),
            {"h": found.household_id, "a": found.account_id},
        )
    return SignedIn(account_id=found.account_id, household_id=found.household_id)
