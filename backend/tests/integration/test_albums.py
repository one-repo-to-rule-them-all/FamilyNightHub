"""Night albums (ADR-0019): photos without a movie night, against real Postgres + RLS."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text

from app.core.database import household_session
from app.core.security import CSRF_HEADER
from app.domain import albums as album_rules
from app.services import consent_service, photo_service
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold
from tests.integration.storage_doubles import FakeStorage, storage

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "PHT234"
TONIGHT = "/api/v1/albums/tonight/photos"


@pytest.fixture
def fake() -> Iterator[FakeStorage]:
    bucket = FakeStorage()
    with storage(bucket):
        yield bucket


def _tonight() -> date:
    return album_rules.night_date(datetime.now(UTC), album_rules.DEFAULT_TIMEZONE)


async def _sql(house: SeededHousehold, sql: str, **params: Any) -> Any:
    async with household_session(house.household_id) as db:
        return await db.execute(text(sql), params)


async def _clear_tonight(h: SeededHousehold) -> None:
    """The seed files its photo into tonight's album; move it away so tonight starts empty."""
    await _sql(
        h,
        "UPDATE albums SET night_date = '2020-01-01' WHERE household_id = :h AND night_date = :d",
        h=h.household_id,
        d=_tonight(),
    )


async def _add_person(h: SeededHousehold) -> uuid.UUID:
    async with household_session(h.household_id) as db:
        pid: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color) "
                    "VALUES (:h, :n, '🦊', '#38bdf8') RETURNING id"
                ),
                {"h": h.household_id, "n": f"Kid {uuid.uuid4().hex[:6]}"},
            )
        ).scalar_one()
    return pid


async def _member(p: Phone, h: SeededHousehold) -> uuid.UUID:
    """Join the household on this phone and bind a fresh person. The night is then deleted
    from the picture: the evening is games only (status draft, no pick)."""
    await open_night(h.household_id, h.ids["session"], CODE, "voting")
    assert (await p.join(h.slug, CODE)).status_code == 200
    person = await _add_person(h)
    assert (await p.bind(person)).status_code == 200
    await _sql(h, "UPDATE sessions SET status = 'draft' WHERE id = :s", s=h.ids["session"])
    return person


async def _host(p: Phone, h: SeededHousehold, role: str = "host") -> None:
    account = await add_account(h.household_id, role, f"{role}.{uuid.uuid4().hex[:10]}@ex.test")
    p.sign_in_as(account, h.household_id)


async def _upload_in(
    p: Phone, h: SeededHousehold, fake: FakeStorage, person: uuid.UUID, path: str = TONIGHT
) -> dict[str, Any]:
    resp = await p.post(path, {"person_id": str(person)})
    assert resp.status_code == 201, resp.text
    body: dict[str, Any] = resp.json()
    for key in photo_service.object_keys(
        h.household_id, uuid.UUID(body["album_id"]), uuid.UUID(body["photo_id"])
    ):
        fake.put(key)
    done = await p.post(f"/api/v1/albums/{body['album_id']}/photos/{body['photo_id']}/complete")
    assert done.status_code == 204, done.text
    return body


# --- Upload with no movie night ----------------------------------------------------------


async def test_upload_on_a_games_only_evening_lands_in_tonights_album(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    await _clear_tonight(a)
    async with phone() as p:
        person = await _member(p, a)
        before = (await p.client.get("/api/v1/albums/tonight")).json()
        assert before["id"] is None and before["photo_count"] == 0 and before["uploads_open"]

        body = await _upload_in(p, a, fake, person)
        row = (
            await _sql(
                a,
                "SELECT album_id, session_id, object_key, status FROM photos WHERE id = :p",
                p=body["photo_id"],
            )
        ).first()
        assert row.session_id is None
        assert str(row.album_id) == body["album_id"]
        assert row.status == "ready"
        assert row.object_key == (
            f"households/{a.household_id}/albums/{body['album_id']}/{body['photo_id']}.jpg"
        )

        album = (await p.client.get("/api/v1/albums/tonight")).json()
        assert album["id"] == body["album_id"]
        assert album["night_date"] == _tonight().isoformat()
        assert album["display_title"] == album_rules.default_title(_tonight())
        assert album["photo_count"] == 1 and album["cover_thumb_url"]

        photos = (await p.client.get(f"/api/v1/albums/{body['album_id']}/photos")).json()
        assert [ph["id"] for ph in photos] == [body["photo_id"]]
        assert photos[0]["url"] and photos[0]["thumb_url"]

        listed = (await p.client.get("/api/v1/albums", params={"limit": 5})).json()
        assert listed[0]["id"] == body["album_id"]


async def test_two_phones_at_once_create_one_album(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    await _clear_tonight(a)
    async with phone() as p1, phone() as p2:
        k1 = await _member(p1, a)
        k2 = await _member(p2, a)
        r1, r2 = await asyncio.gather(
            p1.post(TONIGHT, {"person_id": str(k1)}), p2.post(TONIGHT, {"person_id": str(k2)})
        )
        assert r1.status_code == r2.status_code == 201, (r1.text, r2.text)
        assert r1.json()["album_id"] == r2.json()["album_id"]
    count = (
        await _sql(
            a,
            "SELECT count(*) FROM albums WHERE household_id = :h AND night_date = :d",
            h=a.household_id,
            d=_tonight(),
        )
    ).scalar_one()
    assert count == 1


async def test_tonights_upload_needs_consent_and_a_bound_person(
    two_households: Pair, fake: FakeStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a)
        stranger = await _add_person(a)
        assert (await p.post(TONIGHT, {"person_id": str(stranger)})).status_code == 403
        # The Terms changed and nobody accepted the new version yet (ADR-0017).
        monkeypatch.setattr(consent_service, "TERMS_VERSION", "2099-01-01")
        resp = await p.post(TONIGHT, {"person_id": str(person)})
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "consent_required"
        # Refused before anything was written.
        n = await _sql(a, "SELECT count(*) FROM photos WHERE person_id = :p", p=person)
        assert n.scalar_one() == 0


async def test_csrf_is_required(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a)
        resp = await p.client.post(TONIGHT, json={"person_id": str(person)})
        assert resp.status_code == 403


# --- The movie night path files into the date album ---------------------------------------


async def test_a_movie_nights_upload_lands_in_the_date_album(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    await _clear_tonight(a)
    async with phone() as p:
        person = await _member(p, a)
        await _sql(a, "UPDATE sessions SET status = 'closed' WHERE id = :s", s=a.ids["session"])
        night = await p.post(
            f"/api/v1/sessions/{a.ids['session']}/photos", {"person_id": str(person)}
        )
        assert night.status_code == 201, night.text
        games = await p.post(TONIGHT, {"person_id": str(person)})
        assert games.status_code == 201, games.text
        rows = (
            await _sql(
                a,
                "SELECT id, album_id, session_id FROM photos WHERE person_id = :p "
                "ORDER BY created_at",
                p=person,
            )
        ).all()
        assert len({r.album_id for r in rows}) == 1  # one evening, one album
        assert rows[0].session_id == a.ids["session"]
        assert rows[1].session_id is None
        assert str(rows[0].album_id) == games.json()["album_id"]

        found = await p.client.get(f"/api/v1/albums/by-session/{a.ids['session']}")
        assert found.status_code == 200
        assert found.json()["id"] == games.json()["album_id"]


# --- The 3-day window ---------------------------------------------------------------------


async def test_past_albums_take_uploads_for_three_days_then_409(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a)
        today = _tonight()

        async def album_on(days_ago: int) -> str:
            row = await _sql(
                a,
                "INSERT INTO albums (household_id, night_date) VALUES (:h, :d) RETURNING id",
                h=a.household_id,
                d=today - timedelta(days=days_ago),
            )
            return str(row.scalar_one())

        open_id, closed_id = await album_on(3), await album_on(4)
        ok = await p.post(f"/api/v1/albums/{open_id}/photos", {"person_id": str(person)})
        assert ok.status_code == 201, ok.text
        assert ok.json()["album_id"] == open_id
        shut = await p.post(f"/api/v1/albums/{closed_id}/photos", {"person_id": str(person)})
        assert shut.status_code == 409
        assert "closed" in shut.json()["error"]["message"]
        meta = (await p.client.get(f"/api/v1/albums/{closed_id}")).json()
        assert meta["uploads_open"] is False


# --- Moderation and isolation -------------------------------------------------------------


async def test_hidden_photos_only_for_hosts_and_hosts_rename(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    await _clear_tonight(a)
    async with phone() as p, phone() as host:
        person = await _member(p, a)
        body = await _upload_in(p, a, fake, person)
        aid, pid = body["album_id"], body["photo_id"]
        await _host(host, a)
        csrf = {CSRF_HEADER: await host.csrf()}
        hide = await host.client.post(f"/api/v1/albums/{aid}/photos/{pid}/hide", headers=csrf)
        assert hide.status_code == 204, hide.text

        assert (await p.client.get(f"/api/v1/albums/{aid}/photos")).json() == []
        seen = (await host.client.get(f"/api/v1/albums/{aid}/photos")).json()
        assert [(x["id"], x["status"]) for x in seen] == [(pid, "hidden")]
        # The phone's album list doesn't count it (or show an empty album).
        assert all(x["id"] != aid for x in (await p.client.get("/api/v1/albums")).json())

        # A phone can't rename; a host can, and blank goes back to the date label.
        assert (await p.patch(f"/api/v1/albums/{aid}", {"title": "Nope"})).status_code in (401, 403)
        renamed = await host.client.patch(
            f"/api/v1/albums/{aid}", json={"title": "  Thanksgiving   2026 "}, headers=csrf
        )
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["display_title"] == "Thanksgiving 2026"
        reset = await host.client.patch(f"/api/v1/albums/{aid}", json={"title": " "}, headers=csrf)
        assert reset.json()["title"] is None
        assert reset.json()["display_title"] == album_rules.default_title(_tonight())


async def test_other_households_album_is_404_and_no_urls(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, b = two_households
    await _clear_tonight(a)
    async with phone() as p, phone() as other:
        person = await _member(p, a)
        body = await _upload_in(p, a, fake, person)
        aid, pid = body["album_id"], body["photo_id"]
        stranger = await _member(other, b)
        for path in (f"/api/v1/albums/{aid}", f"/api/v1/albums/{aid}/photos"):
            resp = await other.client.get(path)
            assert resp.status_code == 404
            assert "X-Amz" not in resp.text
        assert (
            await other.post(f"/api/v1/albums/{aid}/photos", {"person_id": str(stranger)})
        ).status_code == 404
        assert (await other.post(f"/api/v1/albums/{aid}/photos/{pid}/complete")).status_code == 404
        b_list = (await other.client.get("/api/v1/albums")).json()
        assert all(x["id"] != aid for x in b_list)


# --- Lifecycle -----------------------------------------------------------------------------


async def test_person_delete_removes_their_photos_and_the_emptied_album(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    await _clear_tonight(a)
    async with phone() as p, phone() as admin:
        person = await _member(p, a)
        body = await _upload_in(p, a, fake, person)
        await _host(admin, a, "admin")
        csrf = {CSRF_HEADER: await admin.csrf()}
        resp = await admin.client.delete(f"/api/v1/admin/people/{person}", headers=csrf)
        assert resp.status_code in (200, 204), resp.text
    left = await _sql(a, "SELECT count(*) FROM albums WHERE id = :a", a=body["album_id"])
    assert left.scalar_one() == 0
    # The seeded album (someone else's photo) is untouched.
    kept = await _sql(a, "SELECT count(*) FROM albums WHERE id = :a", a=a.ids["album"])
    assert kept.scalar_one() == 1


async def test_start_fresh_deletes_albums(two_households: Pair, fake: FakeStorage) -> None:
    a, b = two_households
    async with phone() as admin:
        await _host(admin, a, "admin")
        name = await _sql(a, "SELECT name FROM households WHERE id = :h", h=a.household_id)
        resp = await admin.client.post(
            "/api/v1/admin/start-fresh",
            json={"confirm_name": name.scalar_one()},
            headers={CSRF_HEADER: await admin.csrf()},
        )
        assert resp.status_code == 200, resp.text
    assert (await _sql(a, "SELECT count(*) FROM albums")).scalar_one() == 0
    assert (await _sql(b, "SELECT count(*) FROM albums")).scalar_one() == 1


async def test_household_timezone_is_validated_and_moves_tonight(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    async with phone() as admin:
        await _host(admin, a, "admin")
        csrf = {CSRF_HEADER: await admin.csrf()}
        got = (await admin.client.get("/api/v1/admin/settings")).json()
        assert got["timezone"] == "America/Chicago"
        bad = await admin.client.patch(
            "/api/v1/admin/settings", json={"timezone": "Mars/Olympus"}, headers=csrf
        )
        assert bad.status_code == 422
        ok = await admin.client.patch(
            "/api/v1/admin/settings", json={"timezone": "Pacific/Kiritimati"}, headers=csrf
        )
        assert ok.status_code == 200 and ok.json()["timezone"] == "Pacific/Kiritimati"
        tonight = (await admin.client.get("/api/v1/albums/tonight")).json()
        expected = album_rules.night_date(datetime.now(UTC), "Pacific/Kiritimati")
        assert tonight["night_date"] == expected.isoformat()
