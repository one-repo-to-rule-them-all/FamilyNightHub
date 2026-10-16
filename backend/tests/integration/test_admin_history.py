"""History edit: correct a past night's winner (ADR-0006: a re-close with an audit row,
the stored ranking and tie seed untouched, never a silent re-tally)."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.core.database import household_session
from app.core.security import CSRF_HEADER
from tests.integration.phones import Phone, add_account, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
BASE = "/api/v1/sessions"
SEED_HEADER = "X-FNH-Test-Seed"


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    yield


def _correct_path(sid: str) -> str:
    return f"/api/v1/admin/sessions/{sid}/correct-winner"


async def _correct(p: Phone, sid: str, option_id: str, reason: str = "We watched it") -> Any:
    return await p.post(_correct_path(sid), {"option_id": option_id, "reason": reason})


def _as_admin(p: Phone, h: SeededHousehold) -> None:
    p.sign_in_as(h.ids["account"], h.household_id)


async def _night(p: Phone, h: SeededHousehold, n: int, *, stage: str) -> tuple[str, str, list[str]]:
    """A night with n typed titles taken to `stage` (draft/voting/revealed/closed):
    (session id, night code, option ids in shortlist order)."""
    created = (await p.post(BASE, {"title": "Friday"})).json()
    sid = created["session_id"]
    for i in range(n):
        resp = await p.post(f"{BASE}/{sid}/options", {"title": f"Pick {uuid.uuid4().hex[:6]} {i}"})
        assert resp.status_code == 201, resp.text
    if stage != "draft":
        assert (await p.post(f"{BASE}/{sid}/open-voting")).status_code == 200
    if stage in ("revealed", "closed"):
        resp = await p.client.post(
            f"{BASE}/{sid}/close-voting",
            headers={SEED_HEADER: "7", CSRF_HEADER: await p.csrf()},
        )
        assert resp.status_code == 200, resp.text
    if stage == "closed":
        await _settle(h, sid)
        assert (await p.post(f"{BASE}/{sid}/close")).status_code == 200
    snap = (await p.client.get(f"{BASE}/{sid}")).json()
    return sid, created["night_code"], [o["id"] for o in snap["options"]]


async def _settle(h: SeededHousehold, sid: str) -> None:
    """Let a reveal settle into `tonight` so the night can close (30s rule)."""
    async with household_session(h.household_id) as db:
        await db.execute(
            text(
                "UPDATE sessions SET revealed_at = revealed_at - interval '1 minute' WHERE id = :s"
            ),
            {"s": sid},
        )


async def _rows(h: SeededHousehold, sql: str, **params: Any) -> list[Any]:
    async with household_session(h.household_id) as db:
        return list(await db.execute(text(sql), params))


async def _stored(h: SeededHousehold, sid: str) -> Any:
    rows = await _rows(
        h, "SELECT winner_option_id, ranking, tie_seed FROM sessions WHERE id = :s", s=sid
    )
    return rows[0]


async def _corrections(h: SeededHousehold, sid: str) -> list[Any]:
    return await _rows(
        h,
        "SELECT actor_account_id, data FROM audit_events "
        "WHERE target_id = :s AND action = 'session.winner_corrected' ORDER BY created_at",
        s=sid,
    )


# --- The correction -------------------------------------------------------------------


async def test_correcting_a_winner_keeps_the_ranking_and_audits(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        _as_admin(p, a)
        sid, _code, options = await _night(p, a, 3, stage="revealed")
        before = await _stored(a, sid)
        new = next(o for o in options if o != str(before.winner_option_id))
        resp = await _correct(p, sid, new, "  We actually   watched this one ")
        history = (await p.client.get(BASE, params={"status": "revealed"})).json()

    assert resp.status_code == 200, resp.text
    assert resp.json()["result"]["winner_option_id"] == new
    after = await _stored(a, sid)
    assert str(after.winner_option_id) == new
    assert after.ranking == before.ranking
    assert after.tie_seed == before.tie_seed
    # The snapshot still shows how the vote placed everyone.
    assert resp.json()["result"]["placements"][0]["option_id"] == str(before.winner_option_id)

    audit = await _corrections(a, sid)
    assert len(audit) == 1
    assert audit[0].actor_account_id == a.ids["account"]
    data = audit[0].data
    assert data["from_option_id"] == str(before.winner_option_id)
    assert data["to_option_id"] == new
    assert data["ranked_winner_option_id"] == str(before.winner_option_id)
    assert data["reason"] == "We actually watched this one"
    assert data["to_title"].startswith("Pick ") and data["from_title"].startswith("Pick ")
    listed = next(n for n in history if n["id"] == sid)
    assert listed["winner"]["option_id"] == new


async def test_a_closed_night_can_be_corrected_twice(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        _as_admin(p, a)
        sid, _code, options = await _night(p, a, 2, stage="closed")
        winner = str((await _stored(a, sid)).winner_option_id)
        other = next(o for o in options if o != winner)
        assert (await _correct(p, sid, other)).status_code == 200
        back = await _correct(p, sid, winner, "Changed our minds")
    assert back.status_code == 200
    assert back.json()["status"] == "closed"
    assert str((await _stored(a, sid)).winner_option_id) == winner
    audit = await _corrections(a, sid)
    assert [r.data["to_option_id"] for r in audit] == [other, winner]
    assert audit[1].data["ranked_winner_option_id"] == winner


@pytest.mark.parametrize("stage", ["draft", "voting"])
async def test_a_night_without_a_winner_cannot_be_corrected(
    two_households: Pair, stage: str
) -> None:
    a, _ = two_households
    async with phone() as p:
        _as_admin(p, a)
        sid, _code, options = await _night(p, a, 2, stage=stage)
        resp = await _correct(p, sid, options[0])
    assert resp.status_code == 409
    assert (await _stored(a, sid)).winner_option_id is None
    assert await _corrections(a, sid) == []


async def test_only_this_nights_options_can_win(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as p, phone() as b_admin:
        _as_admin(p, a)
        _as_admin(b_admin, b)
        sid, _code, _options = await _night(p, a, 2, stage="revealed")
        _other, _c, other_options = await _night(p, a, 2, stage="revealed")
        _b_sid, _bc, b_options = await _night(b_admin, b, 2, stage="revealed")
        before = await _stored(a, sid)
        wrong_night = await _correct(p, sid, other_options[0])
        other_house = await _correct(p, sid, b_options[0])
        unknown = await _correct(p, sid, str(uuid.uuid4()))
        same = await _correct(p, sid, str(before.winner_option_id))
    assert wrong_night.status_code == 409
    assert "shortlist" in wrong_night.json()["error"]["message"]
    assert other_house.status_code == 409
    assert unknown.status_code == 409
    assert same.status_code == 409
    assert (await _stored(a, sid)).winner_option_id == before.winner_option_id
    assert await _corrections(a, sid) == []


async def test_another_households_night_is_404(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as p, phone() as b_admin:
        _as_admin(b_admin, b)
        b_sid, _code, b_options = await _night(b_admin, b, 2, stage="revealed")
        _as_admin(p, a)
        resp = await _correct(p, b_sid, b_options[1])
        unknown = await _correct(p, str(uuid.uuid4()), b_options[1])
    assert resp.status_code == 404
    assert unknown.status_code == 404


async def test_correction_needs_admin_history_csrf_and_a_reason(two_households: Pair) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", f"host.{uuid.uuid4().hex[:8]}@ex.test")
    async with phone() as admin, phone() as h, phone() as kid:
        _as_admin(admin, a)
        sid, code, options = await _night(admin, a, 2, stage="revealed")
        winner = str((await _stored(a, sid)).winner_option_id)
        other = next(o for o in options if o != winner)
        h.sign_in_as(host, a.household_id)
        as_host = await _correct(h, sid, other)
        await admin.csrf()
        no_csrf = await admin.client.post(
            _correct_path(sid), json={"option_id": other, "reason": "x"}
        )
        blank = await _correct(admin, sid, other, "   ")
        long = await _correct(admin, sid, other, "x" * 501)
        assert (await kid.join(a.slug, code)).status_code == 200
        as_device = await _correct(kid, sid, other)
    assert as_host.status_code == 403
    assert no_csrf.status_code == 403
    assert blank.status_code == 422 and long.status_code == 422
    assert as_device.status_code == 401
    assert await _corrections(a, sid) == []
