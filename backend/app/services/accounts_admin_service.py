"""Hosts and admins (issue #71, ADR-0014 amendment): invite by email, list, change role,
remove access. `admin:accounts` only.

An invite creates the account with no password and emails a single-use sign-in link (the
ADR-0014 magic link with a longer life). The invitee chooses their own password on
`/auth/callback`; nobody else ever sets or sees it, and the link itself is never returned to
the inviting admin.

Removing access sets `disabled_at` (never a delete: audit rows and nights name the account)
and kills any unused link. `current_account` re-reads the row on every request, so removal
and role changes take effect on the account's next request. Re-inviting a removed address
revives the same row with its password cleared, so an old password never comes back.

**The last admin.** Every role change and removal locks the household's live admin rows
`FOR UPDATE` and refuses (409) if it would leave none. Two admins removing each other at the
same moment are serialized by that lock: the second sees one admin left and is refused.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import hash_magic_link_token, new_token
from app.integrations.email import Email
from app.services.errors import Conflict, NotFound

LAST_ADMIN = "A household needs at least one admin. Make someone else an admin first."
TAKEN = "That email or username already belongs to a Family Night account."


@dataclass(frozen=True)
class AdminAccount:
    id: uuid.UUID
    email: str
    username: str | None
    display_name: str
    role: str
    has_password: bool
    invite_expires_at: datetime | None
    created_at: datetime


@dataclass(frozen=True)
class Invited:
    account: AdminAccount
    email: Email


_SELECT = (
    "SELECT a.id, a.email, a.username, a.display_name, a.role, a.created_at, "
    "a.password_hash IS NOT NULL AS has_password, "
    "(SELECT max(m.expires_at) FROM magic_links m WHERE m.account_id = a.id "
    " AND m.used_at IS NULL AND m.expires_at > now()) AS invite_expires_at "
    "FROM accounts a WHERE a.disabled_at IS NULL"
)


def _row(r: Any) -> AdminAccount:
    return AdminAccount(
        id=r.id,
        email=r.email,
        username=r.username,
        display_name=r.display_name,
        role=r.role,
        has_password=r.has_password,
        invite_expires_at=None if r.has_password else r.invite_expires_at,
        created_at=r.created_at,
    )


async def list_accounts(db: AsyncSession) -> list[AdminAccount]:
    """Live accounts: admins first, then by name."""
    rows = await db.execute(
        text(f"{_SELECT} ORDER BY a.role = 'admin' DESC, lower(a.display_name), a.created_at")
    )
    return [_row(r) for r in rows]


async def get_account(db: AsyncSession, account_id: uuid.UUID) -> AdminAccount:
    row = (await db.execute(text(f"{_SELECT} AND a.id = :a"), {"a": account_id})).first()
    if row is None:
        raise NotFound
    return _row(row)


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    actor_id: uuid.UUID,
    action: str,
    target_id: uuid.UUID,
    data: dict[str, str | bool],
) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :actor, :action, 'account', :t, CAST(:d AS jsonb))"
        ),
        {
            "h": household_id,
            "actor": actor_id,
            "action": action,
            "t": target_id,
            "d": json.dumps(data),
        },
    )


async def _expire_links(db: AsyncSession, account_id: uuid.UUID) -> None:
    """Kill every unused link of the account, so only the newest invite (or none) works."""
    await db.execute(
        text(
            "UPDATE magic_links SET expires_at = now() "
            "WHERE account_id = :a AND used_at IS NULL AND expires_at > now()"
        ),
        {"a": account_id},
    )


async def _invite_email(
    db: AsyncSession, household_id: uuid.UUID, actor_id: uuid.UUID, account: AdminAccount
) -> Email:
    """Mint a fresh invite link (older unused ones die) and the email that carries it."""
    await _expire_links(db, account.id)
    token = new_token()
    expires = datetime.now(UTC) + timedelta(hours=settings.INVITE_LINK_TTL_HOURS)
    await db.execute(
        text(
            "INSERT INTO magic_links (household_id, account_id, token_hash, expires_at) "
            "VALUES (:h, :a, :t, :exp)"
        ),
        {"h": household_id, "a": account.id, "t": hash_magic_link_token(token), "exp": expires},
    )
    names = (
        await db.execute(
            text(
                "SELECT h.name AS household, a.display_name AS inviter FROM households h "
                "JOIN accounts a ON a.household_id = h.id WHERE a.id = :actor"
            ),
            {"actor": actor_id},
        )
    ).one()
    link = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/auth/callback?token={token}&invite=1"
    can = (
        "run movie nights, let phones in and vote for anyone"
        if account.role == "host"
        else "run movie nights and manage people, phones and settings"
    )
    return Email(
        to=account.email,
        subject=f"You're invited to {names.household} on Family Night",
        text=(
            f"{names.inviter} invited you to {names.household} on Family Night as a "
            f"{account.role}: you can {can}.\n\n"
            f"Tap to choose your password and sign in:\n\n{link}\n\n"
            f"The link works once and expires in {settings.INVITE_LINK_TTL_HOURS} hours. "
            "If you weren't expecting this, you can ignore it."
        ),
    )


async def invite(
    db: AsyncSession,
    household_id: uuid.UUID,
    actor_id: uuid.UUID,
    *,
    email: str,
    display_name: str,
    role: str,
    username: str | None,
) -> Invited:
    """Create the account (or revive a removed one of this household) with no password and
    return the invite email. 409 if the address is already live here, or the email or
    username belongs to any account (they are unique across households)."""
    existing = (
        await db.execute(
            text("SELECT id, disabled_at FROM accounts WHERE lower(email) = :e FOR UPDATE"),
            {"e": email},
        )
    ).first()
    if existing is not None and existing.disabled_at is None:
        raise Conflict("That person already has access. Resend their invite instead.")
    try:
        async with db.begin_nested():
            if existing is not None:
                account_id: uuid.UUID = existing.id
                await db.execute(
                    text(
                        "UPDATE accounts SET disabled_at = NULL, role = :r, display_name = :n, "
                        "username = :u, password_hash = NULL, password_changed_at = NULL "
                        "WHERE id = :a"
                    ),
                    {"a": account_id, "r": role, "n": display_name, "u": username},
                )
            else:
                account_id = (
                    await db.execute(
                        text(
                            "INSERT INTO accounts (household_id, email, username, display_name, "
                            "role) VALUES (:h, :e, :u, :n, :r) RETURNING id"
                        ),
                        {
                            "h": household_id,
                            "e": email,
                            "u": username,
                            "n": display_name,
                            "r": role,
                        },
                    )
                ).scalar_one()
    except IntegrityError:
        raise Conflict(TAKEN) from None
    account = await get_account(db, account_id)
    message = await _invite_email(db, household_id, actor_id, account)
    await _audit(
        db,
        household_id,
        actor_id,
        "account.invited",
        account_id,
        {"role": role, "email": email, "reinvited": existing is not None},
    )
    return Invited(await get_account(db, account_id), message)


async def resend_invite(
    db: AsyncSession, household_id: uuid.UUID, actor_id: uuid.UUID, account_id: uuid.UUID
) -> Invited:
    """A fresh link for someone who hasn't set a password yet; the old link stops working."""
    account = await get_account(db, account_id)
    if account.has_password:
        raise Conflict("They already set a password. They can use 'Forgot password' if needed.")
    message = await _invite_email(db, household_id, actor_id, account)
    await _audit(db, household_id, actor_id, "account.invite_resent", account_id, {})
    return Invited(await get_account(db, account_id), message)


async def _admins_locked(db: AsyncSession) -> set[uuid.UUID]:
    rows = await db.execute(
        text(
            "SELECT id FROM accounts WHERE role = 'admin' AND disabled_at IS NULL "
            "ORDER BY id FOR UPDATE"
        )
    )
    return {r.id for r in rows}


async def change_role(
    db: AsyncSession,
    household_id: uuid.UUID,
    actor_id: uuid.UUID,
    account_id: uuid.UUID,
    role: str,
) -> AdminAccount:
    admins = await _admins_locked(db)
    account = await get_account(db, account_id)
    if account.role == role:
        return account
    if account.role == "admin" and admins <= {account_id}:
        raise Conflict(LAST_ADMIN)
    await db.execute(
        text("UPDATE accounts SET role = :r WHERE id = :a"), {"r": role, "a": account_id}
    )
    await _audit(
        db,
        household_id,
        actor_id,
        "account.role_changed",
        account_id,
        {"from": account.role, "to": role},
    )
    return await get_account(db, account_id)


async def remove(
    db: AsyncSession, household_id: uuid.UUID, actor_id: uuid.UUID, account_id: uuid.UUID
) -> None:
    """Disable the account and its unused links. Its nights and audit rows stay."""
    admins = await _admins_locked(db)
    account = await get_account(db, account_id)
    if account.role == "admin" and admins <= {account_id}:
        raise Conflict(LAST_ADMIN)
    await db.execute(
        text("UPDATE accounts SET disabled_at = now() WHERE id = :a"), {"a": account_id}
    )
    await _expire_links(db, account_id)
    await _audit(
        db,
        household_id,
        actor_id,
        "account.removed",
        account_id,
        {"role": account.role, "email": account.email},
    )
