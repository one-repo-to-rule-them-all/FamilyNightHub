from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.core.dependencies import AccountContext, require_permission
from app.core.permissions import ALL_PERMISSIONS, ROLE_PERMISSIONS, has_permission
from app.integrations.email import Email, LogSender, send_safely


def test_admin_has_everything_host_has_night_running_only() -> None:
    assert ROLE_PERMISSIONS["admin"] == ALL_PERMISSIONS
    assert has_permission("host", "sessions:run")
    assert has_permission("host", "ballots:proxy")
    assert not any(has_permission("host", p) for p in ALL_PERMISSIONS if p.startswith("admin:"))


def test_unknown_role_gets_nothing() -> None:
    assert not any(has_permission("member", p) for p in ALL_PERMISSIONS)


def _ctx(role: str) -> AccountContext:
    return AccountContext(uuid.uuid4(), uuid.uuid4(), role)


async def test_require_permission_allows_and_denies() -> None:
    check = require_permission("admin:settings")
    admin = _ctx("admin")
    assert await check(admin) is admin
    with pytest.raises(HTTPException) as denied:
        await check(_ctx("host"))
    assert denied.value.status_code == 403


class Boom:
    async def send(self, message: Email) -> None:
        raise ConnectionError("smtp down")


async def test_failed_send_is_logged_not_raised() -> None:
    await send_safely(Boom(), Email("a@b.co", "s", "t"))


async def test_log_sender_never_needs_a_server() -> None:
    await LogSender().send(Email("a@b.co", "s", "body with a live link"))
