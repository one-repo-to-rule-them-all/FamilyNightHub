"""The platform owner (ADR-0016, option A): an operator who manages households and enters one
at a time, never bypassing RLS.

- **Who** is an operator: a `platform_operators` row, written only by the CLI as the owner.
- **Sign-in** asks for the password again, even with a family session, and issues its own
  cookie (core/security.py). Unknown, not an operator, disabled and wrong password all
  answer the same 401, after one argon2 run each.
- **The list** is the one cross-household read, `platform_list_households()`: metadata and
  counts only (ADR-0017 §6).
- **Everything else** runs in `platform_session(hid)`: the household's own GUC, RLS as usual,
  and `app.platform_account` set so the audit trigger tags each household audit row
  `via: "platform"`. Every action also writes a global `platform_audit_events` row.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import hashing
from app.core.config import settings
from app.core.database import AsyncSessionLocal, household_session
from app.core.security import hash_magic_link_token, new_token
from app.domain import join_slug
from app.integrations.email import Email
from app.services import auth_service, household_settings_service
from app.services.accounts_admin_service import TAKEN
from app.services.errors import Conflict, Invalid, NotFound

MAX_NAME = 120


@dataclass(frozen=True)
class Operator:
    account_id: uuid.UUID
    home_household_id: uuid.UUID


@dataclass(frozen=True)
class HouseholdSummary:
    """ADR-0017 §6: the platform view's fields, each justified there. No admin emails: the
    operator sees those by entering, which is audited."""

    id: uuid.UUID
    name: str
    created_at: datetime
    disabled_at: datetime | None
    delete_after: datetime | None
    people: int
    devices: int
    nights: int
    photos: int
    last_activity: datetime | None


@dataclass(frozen=True)
class Created:
    household: HouseholdSummary
    email: Email


async def _platform_audit(
    account_id: uuid.UUID,
    action: str,
    household_id: uuid.UUID | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    async with AsyncSessionLocal() as session, session.begin():
        await session.execute(
            text(
                "INSERT INTO platform_audit_events (account_id, household_ref, action, data) "
                "VALUES (:a, :h, :action, CAST(:d AS jsonb))"
            ),
            {"a": account_id, "h": household_id, "action": action, "d": json.dumps(data or {})},
        )


@asynccontextmanager
async def platform_session(
    household_id: uuid.UUID, account_id: uuid.UUID
) -> AsyncIterator[AsyncSession]:
    """A household transaction for the operator: RLS bound to `household_id`, audit rows
    tagged by the trigger."""
    async with household_session(household_id) as db:
        await db.execute(
            text("SELECT set_config('app.platform_account', :a, true)"), {"a": str(account_id)}
        )
        yield db


async def _household_audit(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, action: str, data: str
) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :a, :action, 'household', :h, CAST(:d AS jsonb))"
        ),
        {"h": household_id, "a": account_id, "action": action, "d": data},
    )


# --- Sign-in -------------------------------------------------------------------------


async def sign_in(identifier: str, password: str) -> Operator:
    """An operator's password sign-in. Raises auth_service.InvalidCredentials (one answer)."""
    found = await auth_service.resolve_login(identifier)
    if found is None:
        await hashing.verify_password(None, password)
        raise auth_service.InvalidCredentials(None)
    async with household_session(found.household_id) as db:
        row = (
            await db.execute(
                text(
                    "SELECT a.password_hash, o.account_id IS NOT NULL AS operator "
                    "FROM accounts a LEFT JOIN platform_operators o ON o.account_id = a.id "
                    "WHERE a.id = :a AND a.disabled_at IS NULL"
                ),
                {"a": found.account_id},
            )
        ).first()
    stored = row.password_hash if row else None
    if not await hashing.verify_password(stored, password) or not (row and row.operator):
        raise auth_service.InvalidCredentials(found.account_id)
    await _platform_audit(found.account_id, "platform.signed_in")
    return Operator(found.account_id, found.household_id)


async def profile(operator: Operator) -> tuple[str, str]:
    """The operator's email and display name, read in their own household."""
    async with household_session(operator.home_household_id) as db:
        row = (
            await db.execute(
                text("SELECT email, display_name FROM accounts WHERE id = :a"),
                {"a": operator.account_id},
            )
        ).one()
    return row.email, row.display_name


async def signed_out(account_id: uuid.UUID) -> None:
    await _platform_audit(account_id, "platform.signed_out")


# --- Households ------------------------------------------------------------------------


def _summary(r: Any) -> HouseholdSummary:
    return HouseholdSummary(
        id=r.household_id,
        name=r.name,
        created_at=r.created_at,
        disabled_at=r.disabled_at,
        delete_after=r.delete_after,
        people=r.people,
        devices=r.devices,
        nights=r.nights,
        photos=r.photos,
        last_activity=r.last_activity,
    )


async def list_households() -> list[HouseholdSummary]:
    async with AsyncSessionLocal() as session, session.begin():
        rows = await session.execute(text("SELECT * FROM platform_list_households()"))
        return [_summary(r) for r in rows]


async def get_household(household_id: uuid.UUID) -> HouseholdSummary:
    for household in await list_households():
        if household.id == household_id:
            return household
    raise NotFound


async def household_name(household_id: uuid.UUID, account_id: uuid.UUID) -> str:
    async with platform_session(household_id, account_id) as db:
        name: str | None = await db.scalar(text("SELECT name FROM households"))
    if name is None:
        raise NotFound
    return name


async def create_household(
    operator: Operator, *, name: str, admin_email: str, admin_name: str
) -> Created:
    """A new household and its first admin, invited by the ADR-0015 link (72 hours, they
    choose their own password). The admin accepts the Terms on first sign-in (ADR-0017),
    and until then the household's consent gate is closed."""
    name, admin_name = name.strip(), admin_name.strip()
    email = auth_service.normalize_email(admin_email)
    if not name or len(name) > MAX_NAME or not admin_name:
        raise Invalid("A household name and the admin's name are required")
    if "@" not in email:
        raise Invalid("That doesn't look like an email address")
    household_id = uuid.uuid4()
    token = new_token()
    try:
        async with platform_session(household_id, operator.account_id) as db:
            await db.execute(
                text("INSERT INTO households (id, name, join_slug) VALUES (:id, :n, :s)"),
                {"id": household_id, "n": name, "s": join_slug.generate()},
            )
            await db.execute(
                text("INSERT INTO settings (household_id) VALUES (:id)"), {"id": household_id}
            )
            account_id: uuid.UUID = (
                await db.execute(
                    text(
                        "INSERT INTO accounts (household_id, email, display_name, role) "
                        "VALUES (:h, :e, :n, 'admin') RETURNING id"
                    ),
                    {"h": household_id, "e": email, "n": admin_name},
                )
            ).scalar_one()
            await db.execute(
                text(
                    "INSERT INTO magic_links (household_id, account_id, token_hash, expires_at) "
                    "VALUES (:h, :a, :t, :exp)"
                ),
                {
                    "h": household_id,
                    "a": account_id,
                    "t": hash_magic_link_token(token),
                    "exp": datetime.now(UTC) + timedelta(hours=settings.INVITE_LINK_TTL_HOURS),
                },
            )
            await _household_audit(
                db,
                household_id,
                operator.account_id,
                "household.created",
                json.dumps({"first_admin": email}),
            )
    except IntegrityError:
        raise Conflict(TAKEN) from None
    await _platform_audit(operator.account_id, "household.created", household_id)
    link = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/auth/callback?token={token}&invite=1"
    message = Email(
        to=email,
        subject=f"Your Family Night household, {name}, is ready",
        text=(
            f"Family Night is set up for {name}, with you as its admin.\n\n"
            f"Tap to choose your password and sign in:\n\n{link}\n\n"
            "Before anyone joins, you'll be asked to read and accept the Terms and Privacy "
            "Policy, as a parent or guardian of the children you add.\n\n"
            f"The link works once and expires in {settings.INVITE_LINK_TTL_HOURS} hours."
        ),
    )
    return Created(await get_household(household_id), message)


async def enter(operator: Operator, household_id: uuid.UUID) -> str:
    """Audit the entry in the household and on the platform; returns its name."""
    async with platform_session(household_id, operator.account_id) as db:
        name: str | None = await db.scalar(text("SELECT name FROM households"))
        if name is None:
            raise NotFound
        await _household_audit(db, household_id, operator.account_id, "platform.entered", "{}")
    await _platform_audit(operator.account_id, "platform.entered", household_id)
    return name


async def exit_household(operator: Operator, household_id: uuid.UUID) -> None:
    async with platform_session(household_id, operator.account_id) as db:
        if await db.scalar(text("SELECT count(*) FROM households")):
            await _household_audit(db, household_id, operator.account_id, "platform.exited", "{}")
    await _platform_audit(operator.account_id, "platform.exited", household_id)


async def _admin_emails(db: AsyncSession) -> list[str]:
    rows = await db.execute(
        text("SELECT email FROM accounts WHERE role = 'admin' AND disabled_at IS NULL")
    )
    return [r.email for r in rows]


async def set_disabled(
    operator: Operator, household_id: uuid.UUID, *, disabled: bool, reason: str | None
) -> tuple[HouseholdSummary, list[Email]]:
    """Switch a household off (sign-ins and joins refused, nothing deleted) or back on, and
    tell its admins why (the Terms promise that)."""
    reason = (reason or "").strip() or None
    if disabled and reason is None:
        raise Invalid("Say why: the household's admins are told")
    async with platform_session(household_id, operator.account_id) as db:
        row = (
            await db.execute(text("SELECT name, disabled_at FROM households FOR UPDATE"))
        ).first()
        if row is None:
            raise NotFound
        if (row.disabled_at is not None) == disabled:
            raise Conflict("Already switched off" if disabled else "Already switched on")
        await db.execute(
            text(
                "UPDATE households SET disabled_at = CASE WHEN :d THEN now() END, "
                "disable_reminded_at = NULL"
            ),
            {"d": disabled},
        )
        action = "household.disabled" if disabled else "household.enabled"
        await _household_audit(
            db, household_id, operator.account_id, action, json.dumps({"reason": reason})
        )
        recipients = await _admin_emails(db)
    await _platform_audit(operator.account_id, action, household_id, {"reason": reason})
    if disabled:
        subject = f"{row.name} is switched off on Family Night"
        body = (
            f"{row.name} has been switched off: nobody can sign in or join a night until it's "
            f"switched back on. Nothing has been deleted.\n\nWhy: {reason}\n\n"
            "Reply to this email if you have questions."
        )
    else:
        subject = f"{row.name} is back on Family Night"
        body = f"{row.name} is switched back on. Everyone can sign in and join nights again."
    emails = [Email(to=address, subject=subject, text=body) for address in recipients]
    return await get_household(household_id), emails


async def rotate_slug(operator: Operator, household_id: uuid.UUID) -> None:
    """On a family's request (ADR-0016 §7): the old fridge QR stops working."""
    async with platform_session(household_id, operator.account_id) as db:
        if not await db.scalar(text("SELECT count(*) FROM households")):
            raise NotFound
        await household_settings_service.rotate_join_slug(db, household_id, operator.account_id)
    await _platform_audit(operator.account_id, "household.join_slug_rotated", household_id)
