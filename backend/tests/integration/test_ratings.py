"""Ratings: rate after the movie, proxy for kids, read back your own, family averages."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import text

from app.core import permissions
from app.core.config import settings
from app.core.database import household_session
from app.services import rating_service
from tests.integration.phones import Phone, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_voting import (
    _close_voting,
    _host,
    _night,
    _person,
    _phone_for,
    _proxy,
    _rows,
    _send,
)

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
BASE = "/api/v1/sessions"


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    yield


# --- Helpers ---------------------------------------------------------------------------


async def _settle(h: SeededHousehold, sid: str) -> None:
    """Age the reveal past REVEAL_SETTLE, so readers (and ratings) see `tonight`."""
    async with household_session(h.household_id) as db:
        await db.execute(
            text("UPDATE sessions SET revealed_at = now() - interval '1 minute' WHERE id = :s"),
            {"s": sid},
        )


async def _tonight(host: Phone, h: SeededHousehold, n: int = 2) -> tuple[str, str, list[str]]:
    """A night voted on (by proxy), revealed and settled into `tonight`."""
    sid, code, opts = await _night(host, n)
    voter = await _person(h, f"V{uuid.uuid4().hex[:6]}")
    assert (await _proxy(host, sid, voter, opts[0])).status_code == 204
    assert (await _close_voting(host, sid)).status_code == 200
    await _settle(h, sid)
    return sid, code, opts


async def _rate(p: Phone, sid: str, person: uuid.UUID, score: Any) -> Response:
    return await _send(
        p, "PUT", f"{BASE}/{sid}/ratings", {"person_id": str(person), "score": score}
    )


async def _proxy_rate(p: Phone, sid: str, person: uuid.UUID, score: int) -> Response:
    body = {"person_id": str(person), "score": score}
    return await _send(p, "PUT", f"{BASE}/{sid}/ratings/proxy", body)


async def _scores(h: SeededHousehold, sid: str) -> dict[uuid.UUID, int]:
    rows = await _rows(h, "SELECT person_id, score FROM ratings WHERE session_id = :s", s=sid)
    return {r.person_id: r.score for r in rows}


# --- Rating from a phone ---------------------------------------------------------------


async def test_two_people_rate_on_a_shared_phone_and_can_change_it(two_households: Pair) -> None:
    a, _ = two_households
    sam, ana = await _person(a, "Sam"), await _person(a, "Ana")
    async with phone() as host, phone() as shared:
        await _host(host, a)
        sid, code, _ = await _tonight(host, a)
        await _phone_for(shared, a, code, sam)
        assert (await shared.bind(ana)).json()["status"] == "active"
        before = (await shared.client.get(f"{BASE}/{sid}/ratings/mine")).json()

        assert (await _rate(shared, sid, sam, 5)).status_code == 204
        assert (await _rate(shared, sid, sam, 5)).status_code == 204  # idempotent
        assert (await _rate(shared, sid, ana, 2)).status_code == 204
        assert (await _rate(shared, sid, ana, 3)).status_code == 204  # changed her mind
        mine = (await shared.client.get(f"{BASE}/{sid}/ratings/mine")).json()
        snap = (await shared.client.get(f"{BASE}/{sid}")).json()

    assert {(r["person_id"], r["score"]) for r in before} == {(str(sam), None), (str(ana), None)}
    assert {(r["person_id"], r["score"]) for r in mine} == {(str(sam), 5), (str(ana), 3)}
    assert await _scores(a, sid) == {sam: 5, ana: 3}
    assert snap["status"] == "tonight"
    assert snap["rating"] == {"average": 4.0, "count": 2}


async def test_a_phone_cannot_rate_as_someone_it_does_not_hold(two_households: Pair) -> None:
    a, _ = two_households
    sam, ana, zed = await _person(a, "Sam"), await _person(a, "Ana"), await _person(a, "Zed")
    async with phone() as host, phone() as sams, phone() as anas:
        await _host(host, a)
        sid, code, _ = await _tonight(host, a)
        await _phone_for(sams, a, code, sam)
        await _phone_for(anas, a, code, ana)
        other_phones = await _rate(anas, sid, sam, 1)
        nobodys = await _rate(anas, sid, zed, 1)
        host_without_device = await _rate(host, sid, sam, 1)
    assert (other_phones.status_code, nobodys.status_code) == (403, 403)
    assert other_phones.json()["error"]["message"] == "This phone can't rate as them"
    assert host_without_device.status_code == 401
    assert await _scores(a, sid) == {}


async def test_a_pending_claim_cannot_rate(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as first, phone() as second:
        await _host(host, a)
        sid, code, _ = await _tonight(host, a)
        assert await _phone_for(first, a, code, sam) == "active"
        assert await _phone_for(second, a, code, sam) == "pending"
        resp = await _rate(second, sid, sam, 4)
        mine = (await second.client.get(f"{BASE}/{sid}/ratings/mine")).json()
    assert resp.status_code == 403
    assert mine == []
    assert await _scores(a, sid) == {}


async def test_ratings_open_once_the_reveal_settles_and_stay_open_after_close(
    two_households: Pair,
) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, opts = await _night(host, 2, open_voting=False)
        await _phone_for(kid, a, code, sam)
        draft = await _rate(kid, sid, sam, 4)
        draft_proxy = await _proxy_rate(host, sid, sam, 4)
        assert (await host.post(f"{BASE}/{sid}/open-voting")).status_code == 200
        voting = await _rate(kid, sid, sam, 4)
        assert (await _proxy(host, sid, sam, opts[0])).status_code == 204
        assert (await _close_voting(host, sid)).status_code == 200
        revealed = await _rate(kid, sid, sam, 4)  # the reveal is still on screen
        revealed_snap = (await kid.client.get(f"{BASE}/{sid}")).json()
        await _settle(a, sid)
        tonight = await _rate(kid, sid, sam, 4)
        assert (await host.post(f"{BASE}/{sid}/close")).status_code == 200
        closed = await _rate(kid, sid, sam, 5)
        closed_snap = (await kid.client.get(f"{BASE}/{sid}")).json()

    assert [r.status_code for r in (draft, draft_proxy, voting, revealed)] == [409] * 4
    assert revealed.json()["error"]["message"] == "Ratings open once tonight's movie is picked"
    assert revealed_snap["rating"] is None
    assert (tonight.status_code, closed.status_code) == (204, 204)
    assert closed_snap["status"] == "closed"
    assert closed_snap["rating"] == {"average": 5.0, "count": 1}


@pytest.mark.parametrize("score", [0, 6, -1, "great", None])
async def test_scores_outside_1_to_5_are_422(two_households: Pair, score: Any) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, _ = await _tonight(host, a)
        await _phone_for(kid, a, code, sam)
        resp = await _rate(kid, sid, sam, score)
    assert resp.status_code == 422
    assert await _scores(a, sid) == {}


async def test_ratings_need_the_csrf_header(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, _ = await _tonight(host, a)
        await _phone_for(kid, a, code, sam)
        body = {"person_id": str(sam), "score": 3}
        resp = await _send(kid, "PUT", f"{BASE}/{sid}/ratings", body, csrf=False)
    assert resp.status_code == 403
    assert await _scores(a, sid) == {}


async def test_another_households_night_is_404(two_households: Pair) -> None:
    a, b = two_households
    sam_a, sam_b = await _person(a), await _person(b)
    async with phone() as host_a, phone() as host_b, phone() as kid_b:
        await _host(host_a, a)
        await _host(host_b, b)
        sid_a, _code_a, _ = await _tonight(host_a, a)
        _sid_b, code_b, _ = await _tonight(host_b, b)
        await _phone_for(kid_b, b, code_b, sam_b)
        rate = await _rate(kid_b, sid_a, sam_b, 5)
        mine = await kid_b.client.get(f"{BASE}/{sid_a}/ratings/mine")
        proxy_cross_night = await _proxy_rate(host_b, sid_a, sam_b, 5)
        proxy_cross_person = await _proxy_rate(host_b, _sid_b, sam_a, 5)
        unknown = await _rate(kid_b, str(uuid.uuid4()), sam_b, 5)
    assert [r.status_code for r in (rate, mine, proxy_cross_night, unknown)] == [404] * 4
    assert proxy_cross_person.status_code == 404
    assert await _scores(a, sid_a) == {}


# --- Proxy -----------------------------------------------------------------------------


async def test_a_host_proxy_rates_for_a_kid_and_is_audited(two_households: Pair) -> None:
    a, _ = two_households
    toddler = await _person(a, "Toddler", "🐣")
    async with phone() as host:
        account = await _host(host, a)
        sid, _code, _ = await _tonight(host, a)
        assert (await _proxy_rate(host, sid, toddler, 2)).status_code == 204
        assert (await _proxy_rate(host, sid, toddler, 4)).status_code == 204  # replaceable
        unknown = await _proxy_rate(host, sid, uuid.uuid4(), 3)
    assert await _scores(a, sid) == {toddler: 4}
    assert unknown.status_code == 404
    audit = await _rows(
        a,
        "SELECT actor_account_id, target_type, data FROM audit_events "
        "WHERE action = 'rating.proxy_rated' AND target_id = :s",
        s=sid,
    )
    # Who rated for whom, never the score.
    assert [(r.actor_account_id, r.target_type, r.data) for r in audit] == [
        (account, "session", {"person_id": str(toddler)})
    ] * 2


async def test_proxy_rating_needs_the_permission(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    toddler = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, _ = await _tonight(host, a)
        monkeypatch.setitem(
            permissions.ROLE_PERMISSIONS,
            "host",
            permissions.ROLE_PERMISSIONS["host"] - {"ballots:proxy"},
        )
        no_permission = await _proxy_rate(host, sid, toddler, 3)
        assert (await kid.join(a.slug, code)).status_code == 200
        device_only = await _proxy_rate(kid, sid, toddler, 3)
    assert no_permission.status_code == 403
    assert device_only.status_code == 401
    assert await _scores(a, sid) == {}


# --- Averages --------------------------------------------------------------------------


async def test_history_and_snapshot_show_the_family_average_only(two_households: Pair) -> None:
    a, _ = two_households
    sam, ana, max_ = await _person(a, "Sam"), await _person(a, "Ana"), await _person(a, "Max")
    async with phone() as host, phone() as kid, phone() as tv:
        await _host(host, a)
        rated, code, _ = await _tonight(host, a)
        unrated, _c, _ = await _tonight(host, a)
        voting, _c2, _ = await _night(host, 2)
        await _phone_for(kid, a, code, sam)
        assert (await tv.join(a.slug, code)).status_code == 200
        assert (await _rate(kid, rated, sam, 5)).status_code == 204
        assert (await _proxy_rate(host, rated, ana, 4)).status_code == 204
        assert (await _proxy_rate(host, rated, max_, 4)).status_code == 204
        history = await tv.client.get(BASE, params={"status": ["tonight", "voting"]})
        snap = await tv.client.get(f"{BASE}/{rated}")
        voting_snap = (await tv.client.get(f"{BASE}/{voting}")).json()

    by_id = {n["id"]: n for n in history.json()}
    assert by_id[rated]["rating"]["count"] == 3
    assert by_id[rated]["rating"]["average"] == pytest.approx(13 / 3)
    assert by_id[unrated]["rating"] == {"average": None, "count": 0}
    assert by_id[voting]["rating"] is None
    assert voting_snap["rating"] is None
    assert snap.json()["rating"]["count"] == 3
    # Nobody's own score leaks: the TV sees the average and count, no person ids.
    assert set(snap.json()["rating"]) == {"average", "count"}
    assert '"score"' not in history.text
    for resp in (history, snap):
        assert str(sam) not in resp.text and str(ana) not in resp.text


async def test_average_rating_for_the_generator(two_households: Pair) -> None:
    a, b = two_households
    sam, ana = await _person(a, "Sam"), await _person(a, "Ana")
    async with phone() as host, phone() as host_b:
        await _host(host, a)
        await _host(host_b, b)
        old, _c, (o_old, _x) = await _tonight(host, a)
        recent, _c2, (o_recent, _y) = await _tonight(host, a)
        assert (await _proxy_rate(host, old, sam, 1)).status_code == 204
        assert (await _proxy_rate(host, recent, sam, 5)).status_code == 204
        assert (await _proxy_rate(host, recent, ana, 4)).status_code == 204
        other_night, _c3, _ = await _tonight(host_b, b)

    async with household_session(a.household_id) as db:
        # Make both winners the same library movie; the old night is 2 years back.
        movie = (
            await db.execute(text("SELECT movie_id FROM options WHERE id = :o"), {"o": o_recent})
        ).scalar_one()
        await db.execute(
            text("UPDATE options SET movie_id = :m WHERE id = :o"), {"m": movie, "o": o_old}
        )
        await db.execute(
            text("UPDATE sessions SET revealed_at = now() - interval '2 years' WHERE id = :s"),
            {"s": old},
        )
    year_ago = datetime.now(UTC) - timedelta(days=365)
    async with household_session(a.household_id) as db:
        last_year = await rating_service.average_rating(db, movie, year_ago)
        ever = await rating_service.average_rating(db, movie, year_ago - timedelta(days=3650))
        unrated = await rating_service.average_rating(db, uuid.uuid4(), year_ago)
        batch = await rating_service.average_ratings(db, [movie, uuid.uuid4()])
        none_asked = await rating_service.average_ratings(db, [])
    async with household_session(b.household_id) as db:
        cross_household = await rating_service.average_rating(db, movie, year_ago)

    assert last_year == rating_service.RatingAverage(4.5, 2)
    assert ever is not None and ever.count == 3
    assert ever.average == pytest.approx(10 / 3)
    assert unrated is None
    assert batch == {movie: ever}  # no `since`: every night it won; unrated ids are absent
    assert none_asked == {}
    assert cross_household is None
    assert other_night  # household b's night exists but never counts for a's movie
