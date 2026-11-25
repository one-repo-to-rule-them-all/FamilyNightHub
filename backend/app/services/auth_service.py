"""Host and admin sign-in (ADR-0014): username or email + password. Members never have
accounts.

The magic link survives only as "forgot password": verifying one sets a new password and
signs in, in one transaction. Links are 256-bit, stored only as a peppered hash, valid for
MAGIC_LINK_TTL_MINUTES and single-use. Consumption is an `UPDATE ... WHERE used_at IS NULL
RETURNING`, so two tabs racing the same link cannot both sign in.

Login answers one way for an unknown identifier, a disabled account, an account with no
password and a wrong password, and runs one argon2 verification in every case (against a
dummy hash when there is no real one). Throttling is the router's (core/rate_limit.py).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import hashing
from app.core.config import settings
from app.core.database import AsyncSessionLocal, household_session
from app.core.security import hash_magic_link_token, new_token
from app.domain import credentials
from app.integrations.email import Email
from app.services.errors import Forbidden, HouseholdDisabled, Invalid, ServiceError


class InvalidLink(ServiceError):
    """Unknown, expired, already used, or the account is disabled: one answer for all."""


class InvalidCredentials(ServiceError):
    """Unknown identifier, disabled, no password yet, or wrong password: one answer for all.
    `account_id` is set when the identifier resolved, so the router can spend the
    per-account budget; it never reaches the client."""

    def __init__(self, account_id: uuid.UUID | None) -> None:
        super().__init__()
        self.account_id = account_id


class WrongPassword(Forbidden):
    """Changing a password with a wrong (or missing) current one."""


@dataclass(frozen=True)
class SignedIn:
    account_id: uuid.UUID
    household_id: uuid.UUID


@dataclass(frozen=True)
class AccountSummary:
    id: uuid.UUID
    email: str
    username: str | None
    display_name: str
    role: str
    household_name: str
    has_password: bool


async def account_summary(db: AsyncSession, account_id: uuid.UUID) -> AccountSummary:
    row = (
        await db.execute(
            text(
                "SELECT a.id, a.email, a.username, a.display_name, a.role, "
                "a.password_hash IS NOT NULL AS has_password, h.name AS household_name "
                "FROM accounts a JOIN households h ON h.id = a.household_id WHERE a.id = :a"
            ),
            {"a": account_id},
        )
    ).one()
    return AccountSummary(
        row.id,
        row.email,
        row.username,
        row.display_name,
        row.role,
        row.household_name,
        row.has_password,
    )


def normalize_email(email: str) -> str:
    return email.strip().lower()


def normalize_login(identifier: str) -> str:
    """The rate-limit identity of a login: emails and usernames are both case-insensitive."""
    return identifier.strip().lower()


# --- Password login ----------------------------------------------------------------


async def resolve_login(identifier: str) -> SignedIn | None:
    """(account, household) for a live account by email (contains '@') or username.
    ADR-0009 resolvers only: runs before any household GUC and returns ids only."""
    ident = normalize_login(identifier)
    fn = "auth_resolve_account_by_email" if "@" in ident else "auth_resolve_account_by_username"
    async with AsyncSessionLocal() as session, session.begin():
        found = (
            await session.execute(
                text(f"SELECT account_id, household_id FROM {fn}(:i)"), {"i": ident}
            )
        ).first()
    return SignedIn(found.account_id, found.household_id) if found else None


async def login(found: SignedIn | None, password: str) -> SignedIn:
    """Check the password of a resolved account (None burns the same argon2 time)."""
    if found is None:
        await hashing.verify_password(None, password)
        raise InvalidCredentials(None)
    async with household_session(found.household_id) as db:
        stored: str | None = await db.scalar(
            text("SELECT password_hash FROM accounts WHERE id = :a AND disabled_at IS NULL"),
            {"a": found.account_id},
        )
        if stored is None or not await hashing.verify_password(stored, password):
            if stored is None:
                await hashing.verify_password(None, password)
            raise InvalidCredentials(found.account_id)
        await require_enabled(db)
        if hashing.needs_rehash(stored):
            await db.execute(
                text("UPDATE accounts SET password_hash = :h WHERE id = :a"),
                {"h": await hashing.hash_password(password), "a": found.account_id},
            )
        await _audit_sign_in(db, found, "password")
    return found


async def require_enabled(db: AsyncSession) -> None:
    """ADR-0016: the request's household hasn't been switched off by the operator."""
    if await db.scalar(text("SELECT disabled_at IS NOT NULL FROM households")):
        raise HouseholdDisabled


async def _audit_sign_in(db: AsyncSession, signed_in: SignedIn, method: str) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :a, 'account.signed_in', 'account', :a, "
            "jsonb_build_object('method', CAST(:m AS text)))"
        ),
        {"h": signed_in.household_id, "a": signed_in.account_id, "m": method},
    )


async def _store_password(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, password: str, via: str
) -> None:
    """Check the rules (incl. not the account's own username/email), hash, store, audit."""
    row = (
        await db.execute(
            text("SELECT username, email FROM accounts WHERE id = :a"), {"a": account_id}
        )
    ).one()
    try:
        credentials.check_password(password, username=row.username, email=row.email)
    except ValueError as exc:
        raise Invalid(str(exc)) from None
    await db.execute(
        text("UPDATE accounts SET password_hash = :h, password_changed_at = now() WHERE id = :a"),
        {"h": await hashing.hash_password(password), "a": account_id},
    )
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :a, 'account.password_set', 'account', :a, "
            "jsonb_build_object('via', CAST(:via AS text)))"
        ),
        {"h": household_id, "a": account_id, "via": via},
    )


async def set_password(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    new_password: str,
    current_password: str | None,
) -> None:
    """Set a first password, or change one; changing needs the current password."""
    stored: str | None = await db.scalar(
        text("SELECT password_hash FROM accounts WHERE id = :a FOR UPDATE"), {"a": account_id}
    )
    if stored is not None and (
        current_password is None or not await hashing.verify_password(stored, current_password)
    ):
        raise WrongPassword("Current password is wrong")
    await _store_password(
        db, household_id, account_id, new_password, "change" if stored else "first"
    )


# --- Forgot password (magic link) ----------------------------------------------------


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
        subject="Reset your Family Night password",
        text=(
            f"Tap to choose a new Family Night password and sign in:\n\n{link}\n\n"
            f"The link works once and expires in {settings.MAGIC_LINK_TTL_MINUTES} minutes. "
            "If you didn't ask for it, you can ignore this email; your password is unchanged."
        ),
    )


async def verify_magic_link(token: str, new_password: str) -> SignedIn:
    """Forgot password: consume the link, set `new_password`, sign in. One transaction, so
    a password the rules reject (Invalid) rolls the consumption back and the link still
    works."""
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
        await require_enabled(db)
        signed_in = SignedIn(account_id=found.account_id, household_id=found.household_id)
        # An invited account (issue #71) sets its first password here: audited as "invite".
        had_password = await db.scalar(
            text("SELECT password_hash IS NOT NULL FROM accounts WHERE id = :a"),
            {"a": found.account_id},
        )
        via = "reset" if had_password else "invite"
        await _store_password(db, found.household_id, found.account_id, new_password, via)
        await _audit_sign_in(db, signed_in, "magic_link")
    return signed_in
