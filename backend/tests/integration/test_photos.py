"""The night's photo album: presign, complete, list, react, hide, delete (ADR-0005)."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

import pytest
from httpx import Response
from sqlalchemy import text

from app.core.database import household_session
from app.core.security import CSRF_HEADER
from app.services import photo_service
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold
from tests.integration.storage_doubles import FAKE_HOST, DownStorage, FakeStorage, storage

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "PHT234"
HEART = "❤️"
TEN_MB = 10 * 1024 * 1024


@pytest.fixture
def fake() -> Iterator[FakeStorage]:
    bucket = FakeStorage()
    with storage(bucket):
        yield bucket


def _base(sid: uuid.UUID | str) -> str:
    return f"/api/v1/sessions/{sid}/photos"


async def _send(
    p: Phone, method: str, path: str, body: Any = None, *, csrf: bool = True, **params: Any
) -> Response:
    headers = {CSRF_HEADER: await p.csrf()} if csrf else {}
    return await p.client.request(method, path, json=body, headers=headers, params=params or None)


async def _add_person(h: SeededHousehold, name: str) -> uuid.UUID:
    async with household_session(h.household_id) as db:
        pid: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color) "
                    "VALUES (:h, :n, '🐙', '#38bdf8') RETURNING id"
                ),
                {"h": h.household_id, "n": name},
            )
        ).scalar_one()
    return pid


async def _set_status(h: SeededHousehold, status: str, revealed_at: datetime | None = None) -> None:
    async with household_session(h.household_id) as db:
        await db.execute(
            text("UPDATE sessions SET status = :s, revealed_at = :r WHERE id = :id"),
            {"s": status, "r": revealed_at, "id": h.ids["session"]},
        )


async def _member(p: Phone, h: SeededHousehold, status: str = "tonight") -> uuid.UUID:
    """Join `h`'s night on this phone and bind a fresh person; the night ends in `status`."""
    await open_night(h.household_id, h.ids["session"], CODE, "voting")
    resp = await p.join(h.slug, CODE)
    assert resp.status_code == 200, resp.text
    person = await _add_person(h, f"Kid {uuid.uuid4().hex[:6]}")
    assert (await p.bind(person)).status_code == 200
    await _set_status(h, status)
    return person


async def _create(p: Phone, h: SeededHousehold, person: uuid.UUID, **extra: Any) -> Response:
    return await p.post(_base(h.ids["session"]), {"person_id": str(person), **extra})


def _keys(h: SeededHousehold, photo_id: str) -> tuple[str, str]:
    return photo_service.object_keys(h.household_id, h.ids["session"], uuid.UUID(photo_id))


async def _ready_photo(p: Phone, h: SeededHousehold, fake: FakeStorage, person: uuid.UUID) -> str:
    resp = await _create(p, h, person)
    assert resp.status_code == 201, resp.text
    photo_id: str = resp.json()["photo_id"]
    for key in _keys(h, photo_id):
        fake.put(key)
    done = await p.post(f"{_base(h.ids['session'])}/{photo_id}/complete")
    assert done.status_code == 204, done.text
    return photo_id


async def _photo_row(h: SeededHousehold, photo_id: str) -> Any:
    async with household_session(h.household_id) as db:
        return (
            await db.execute(
                text("SELECT status, bytes, taken_at FROM photos WHERE id = :p"), {"p": photo_id}
            )
        ).first()


async def _album(p: Phone, h: SeededHousehold) -> list[dict[str, Any]]:
    resp = await p.client.get(_base(h.ids["session"]))
    assert resp.status_code == 200, resp.text
    body: list[dict[str, Any]] = resp.json()
    return body


async def _host(p: Phone, h: SeededHousehold, role: str = "host") -> uuid.UUID:
    account = await add_account(h.household_id, role, f"{role}.{uuid.uuid4().hex[:10]}@ex.test")
    p.sign_in_as(account, h.household_id)
    return account


async def _audit(h: SeededHousehold, photo_id: str) -> list[str]:
    async with household_session(h.household_id) as db:
        rows = await db.execute(
            text(
                "SELECT action FROM audit_events WHERE target_type = 'photo' AND target_id = :p "
                "ORDER BY created_at"
            ),
            {"p": photo_id},
        )
        return [r.action for r in rows]


# --- Upload: presign, PUT, complete ------------------------------------------------------


async def test_upload_flow_presigns_completes_and_lists(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a)
        resp = await _create(p, a, person, taken_on="2026-10-09")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        key, thumb = _keys(a, body["photo_id"])
        assert (
            key == f"households/{a.household_id}/sessions/{a.ids['session']}/{body['photo_id']}.jpg"
        )
        assert thumb == key.removesuffix(".jpg") + "_thumb.jpg"
        assert body["upload_url"].startswith(f"{FAKE_HOST}/{quote(key)}?op=put")
        assert body["thumb_upload_url"].startswith(f"{FAKE_HOST}/{quote(thumb)}?op=put")
        assert body["expires_in"] == 300

        # Pending photos are not in the album.
        assert await _album(p, a) == []
        assert (await _photo_row(a, body["photo_id"])).status == "pending"

        fake.put(key, size=612_345)
        fake.put(thumb, size=40_000)
        done = await p.post(f"{_base(a.ids['session'])}/{body['photo_id']}/complete")
        assert done.status_code == 204, done.text
        row = await _photo_row(a, body["photo_id"])
        assert (row.status, row.bytes) == ("ready", 612_345)

        # Completing again is a no-op.
        again = await p.post(f"{_base(a.ids['session'])}/{body['photo_id']}/complete")
        assert again.status_code == 204

        [photo] = await _album(p, a)
        assert photo["id"] == body["photo_id"]
        assert photo["person_id"] == str(person)
        assert photo["person_avatar_emoji"] == "🐙"
        assert photo["status"] == "ready"
        assert photo["taken_on"] == "2026-10-09"
        assert photo["url"].startswith(f"{FAKE_HOST}/{quote(key)}?op=get")
        assert photo["thumb_url"].startswith(f"{FAKE_HOST}/{quote(thumb)}?op=get")
        assert photo["reactions"] == [] and photo["my_reactions"] == []


@pytest.mark.parametrize(
    ("full", "thumb", "reason"),
    [
        (None, (1000, "image/jpeg"), "photo was not uploaded"),
        ((1000, "image/jpeg"), None, "thumbnail was not uploaded"),
        ((1000, "image/png"), (1000, "image/jpeg"), "photo must be a JPEG"),
        ((1000, None), (1000, "image/jpeg"), "photo must be a JPEG"),
        ((1000, "image/jpeg"), (1000, "image/heic"), "thumbnail must be a JPEG"),
        ((0, "image/jpeg"), (1000, "image/jpeg"), "between 1 byte and 10 MB"),
        ((TEN_MB + 1, "image/jpeg"), (1000, "image/jpeg"), "between 1 byte and 10 MB"),
    ],
)
async def test_complete_rejects_bad_uploads_and_stays_pending(
    two_households: Pair,
    fake: FakeStorage,
    full: tuple[int, str | None] | None,
    thumb: tuple[int, str | None] | None,
    reason: str,
) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a)
        photo_id = (await _create(p, a, person)).json()["photo_id"]
        key, thumb_key = _keys(a, photo_id)
        for k, spec in ((key, full), (thumb_key, thumb)):
            if spec is not None:
                fake.put(k, size=spec[0], content_type=spec[1])
        resp = await p.post(f"{_base(a.ids['session'])}/{photo_id}/complete")
        assert resp.status_code == 422, resp.text
        assert reason in resp.json()["error"]["message"]
        assert (await _photo_row(a, photo_id)).status == "pending"
        assert await _album(p, a) == []


async def test_complete_accepts_exactly_ten_mb_and_jpeg_with_params(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a)
        photo_id = (await _create(p, a, person)).json()["photo_id"]
        key, thumb = _keys(a, photo_id)
        fake.put(key, size=TEN_MB)
        fake.put(thumb, size=1, content_type="Image/JPEG; charset=binary")
        resp = await p.post(f"{_base(a.ids['session'])}/{photo_id}/complete")
        assert resp.status_code == 204, resp.text


async def test_only_the_uploading_device_completes(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as p, phone() as other:
        person = await _member(p, a)
        await _member(other, a)
        photo_id = (await _create(p, a, person)).json()["photo_id"]
        for key in _keys(a, photo_id):
            fake.put(key)
        resp = await other.post(f"{_base(a.ids['session'])}/{photo_id}/complete")
        assert resp.status_code == 404
        assert (await _photo_row(a, photo_id)).status == "pending"


async def test_complete_with_storage_down_is_503(two_households: Pair) -> None:
    a, _ = two_households
    with storage(DownStorage()):
        async with phone() as p:
            person = await _member(p, a)
            photo_id = (await _create(p, a, person)).json()["photo_id"]
            resp = await p.post(f"{_base(a.ids['session'])}/{photo_id}/complete")
            assert resp.status_code == 503
            assert (await _photo_row(a, photo_id)).status == "pending"


@pytest.mark.parametrize("status", ["draft", "voting"])
async def test_no_photos_before_the_pick(
    two_households: Pair, fake: FakeStorage, status: str
) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a, status)
        resp = await _create(p, a, person)
        assert resp.status_code == 409
        assert "Photos open" in resp.json()["error"]["message"]


async def test_photos_open_once_the_reveal_settles_and_after_close(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a)
        await _set_status(a, "revealed", datetime.now(UTC))
        assert (await _create(p, a, person)).status_code == 409
        await _set_status(a, "revealed", datetime.now(UTC) - timedelta(seconds=31))
        assert (await _create(p, a, person)).status_code == 201
        await _set_status(a, "closed")
        assert (await _create(p, a, person)).status_code == 201


async def test_album_cap(
    two_households: Pair, fake: FakeStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    monkeypatch.setattr(photo_service, "MAX_PHOTOS_PER_NIGHT", 2)
    async with phone() as p:
        person = await _member(p, a)
        # The seeded household already has one (pending) photo on this night.
        assert (await _create(p, a, person)).status_code == 201
        resp = await _create(p, a, person)
        assert resp.status_code == 409
        assert "already has 2 photos" in resp.json()["error"]["message"]


async def test_device_not_bound_to_person_is_403(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as p:
        await _member(p, a)
        stranger = await _add_person(a, "Unbound")
        assert (await _create(p, a, stranger)).status_code == 403
        # A pending claim (the seeded kid is actively bound to the seeded device) isn't enough.
        assert (await p.bind(a.ids["person"])).json()["status"] == "pending"
        assert (await _create(p, a, a.ids["person"])).status_code == 403


async def test_create_needs_csrf_and_storage(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a)
        resp = await _send(
            p, "POST", _base(a.ids["session"]), {"person_id": str(person)}, csrf=False
        )
        assert resp.status_code == 403
        with storage(None):
            assert (await _create(p, a, person)).status_code == 503


# --- Household boundary: no URL ever leaves for the wrong caller -------------------------


async def test_other_household_gets_404_and_no_urls(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, b = two_households
    async with phone() as pa, phone() as pb:
        person_a = await _member(pa, a)
        person_b = await _member(pb, b)
        photo_a = await _ready_photo(pa, a, fake, person_a)
        sid_a = a.ids["session"]

        responses = [
            await pb.client.get(_base(sid_a)),
            await pb.post(_base(sid_a), {"person_id": str(person_b)}),
            await pb.post(f"{_base(sid_a)}/{photo_a}/complete"),
            await _send(
                pb, "PUT", f"{_base(sid_a)}/{photo_a}/reactions/{HEART}", person_id=str(person_b)
            ),
            # b's own night id with a's photo id: still not b's photo.
            await _send(
                pb,
                "PUT",
                f"{_base(b.ids['session'])}/{photo_a}/reactions/{HEART}",
                person_id=str(person_b),
            ),
        ]
        for resp in responses:
            assert resp.status_code == 404, resp.text
            assert FAKE_HOST not in resp.text

        await _host(pb, b, "admin")
        for resp in [
            await pb.client.get(_base(sid_a)),
            await pb.post(f"{_base(sid_a)}/{photo_a}/hide"),
            await _send(pb, "DELETE", f"{_base(sid_a)}/{photo_a}"),
        ]:
            assert resp.status_code == 404, resp.text
        assert (await _photo_row(a, photo_a)).status == "ready"


async def test_unauthenticated_client_never_receives_a_url(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a)
        await _ready_photo(p, a, fake, person)
    async with phone() as anon:
        sid = a.ids["session"]
        for resp in [
            await anon.client.get(_base(sid)),
            await anon.post(_base(sid), {"person_id": str(person)}),
        ]:
            assert resp.status_code == 401
            assert FAKE_HOST not in resp.text
        # A forged device cookie is no better.
        anon.client.cookies.set("fnh_device", "forged", domain="fnh.test")
        resp = await anon.client.get(_base(sid))
        assert resp.status_code == 401 and FAKE_HOST not in resp.text


async def test_album_urls_are_only_for_the_callers_household(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, b = two_households
    async with phone() as pa, phone() as pb:
        await _ready_photo(pa, a, fake, await _member(pa, a))
        await _ready_photo(pb, b, fake, await _member(pb, b))
        for p, mine, theirs in ((pa, a, b), (pb, b, a)):
            album = await _album(p, mine)
            assert len(album) == 1
            for url in (album[0]["url"], album[0]["thumb_url"]):
                assert f"households/{mine.household_id}/" in url
                assert str(theirs.household_id) not in url


async def test_tv_and_accounts_can_view_the_album(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as p, phone() as host:
        await _ready_photo(p, a, fake, await _member(p, a))
        await _host(host, a)
        [photo] = await _album(host, a)
        assert photo["my_reactions"] == []


# --- Reactions -----------------------------------------------------------------------------


async def test_reactions_are_idempotent_per_person(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as p, phone() as other:
        person = await _member(p, a)
        other_person = await _member(other, a)
        photo_id = await _ready_photo(p, a, fake, person)
        path = f"{_base(a.ids['session'])}/{photo_id}/reactions"

        for _ in range(2):
            resp = await _send(p, "PUT", f"{path}/{HEART}", person_id=str(person))
            assert resp.status_code == 204, resp.text
        assert (
            await _send(other, "PUT", f"{path}/{HEART}", person_id=str(other_person))
        ).status_code == 204
        assert (
            await _send(other, "PUT", f"{path}/🍿", person_id=str(other_person))
        ).status_code == 204

        [photo] = await _album(p, a)
        assert {r["emoji"]: r["count"] for r in photo["reactions"]} == {HEART: 2, "🍿": 1}
        assert photo["my_reactions"] == [{"person_id": str(person), "emoji": HEART}]

        for _ in range(2):
            resp = await _send(p, "DELETE", f"{path}/{HEART}", person_id=str(person))
            assert resp.status_code == 204
        [photo] = await _album(p, a)
        assert {r["emoji"]: r["count"] for r in photo["reactions"]} == {HEART: 1, "🍿": 1}
        assert photo["my_reactions"] == []


async def test_reaction_rules(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as p:
        person = await _member(p, a)
        photo_id = await _ready_photo(p, a, fake, person)
        path = f"{_base(a.ids['session'])}/{photo_id}/reactions"
        # Not on the allowlist.
        assert (await _send(p, "PUT", f"{path}/💩", person_id=str(person))).status_code == 422
        # Not bound to this device.
        stranger = await _add_person(a, "Stranger")
        assert (
            await _send(p, "PUT", f"{path}/{HEART}", person_id=str(stranger))
        ).status_code == 403
        assert (
            await _send(p, "DELETE", f"{path}/{HEART}", person_id=str(stranger))
        ).status_code == 403
        # CSRF.
        resp = await _send(p, "PUT", f"{path}/{HEART}", csrf=False, person_id=str(person))
        assert resp.status_code == 403
        # A pending photo can't be reacted to.
        pending = (await _create(p, a, person)).json()["photo_id"]
        resp = await _send(
            p,
            "PUT",
            f"{_base(a.ids['session'])}/{pending}/reactions/{HEART}",
            person_id=str(person),
        )
        assert resp.status_code == 404


async def test_service_rejects_unknown_emoji() -> None:
    from app.services.errors import Invalid

    for call in (photo_service.react, photo_service.unreact):
        with pytest.raises(Invalid):
            await call(
                None,  # type: ignore[arg-type]  # rejected before any query
                uuid.uuid4(),
                uuid.uuid4(),
                uuid.uuid4(),
                uuid.uuid4(),
                uuid.uuid4(),
                "💩",
            )


# --- Moderation ------------------------------------------------------------------------------


async def test_hosts_hide_and_unhide(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as p, phone() as host:
        person = await _member(p, a)
        photo_id = await _ready_photo(p, a, fake, person)
        sid = a.ids["session"]

        # A device has no account: moderation is 401 for it.
        assert (await p.post(f"{_base(sid)}/{photo_id}/hide")).status_code == 401

        await _host(host, a)
        for _ in range(2):
            assert (await host.post(f"{_base(sid)}/{photo_id}/hide")).status_code == 204
        assert (await _photo_row(a, photo_id)).status == "hidden"
        assert await _album(p, a) == []
        [seen] = await _album(host, a)
        assert seen["status"] == "hidden"
        # Hidden photos can't be reacted to.
        resp = await _send(
            p, "PUT", f"{_base(sid)}/{photo_id}/reactions/{HEART}", person_id=str(person)
        )
        assert resp.status_code == 404

        assert (await host.post(f"{_base(sid)}/{photo_id}/unhide")).status_code == 204
        assert len(await _album(p, a)) == 1
        assert await _audit(a, photo_id) == ["photo.hidden", "photo.unhidden"]

        # Hosts may not hard-delete.
        assert (await _send(host, "DELETE", f"{_base(sid)}/{photo_id}")).status_code == 403
        # CSRF on moderation.
        resp = await _send(host, "POST", f"{_base(sid)}/{photo_id}/hide", csrf=False)
        assert resp.status_code == 403


async def test_cannot_hide_a_pending_photo(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        resp = await host.post(f"{_base(a.ids['session'])}/{a.ids['photo']}/hide")
        assert resp.status_code == 409


async def test_admin_hard_delete_writes_tombstone(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as p, phone() as admin:
        person = await _member(p, a)
        photo_id = await _ready_photo(p, a, fake, person)
        sid = a.ids["session"]
        key, thumb = _keys(a, photo_id)
        assert (
            await _send(
                p, "PUT", f"{_base(sid)}/{photo_id}/reactions/{HEART}", person_id=str(person)
            )
        ).status_code == 204

        await _host(admin, a, "admin")
        assert (await _send(admin, "DELETE", f"{_base(sid)}/{photo_id}")).status_code == 204

        assert key not in fake.objects and thumb not in fake.objects
        assert fake.deleted == [key, thumb]
        assert await _photo_row(a, photo_id) is None
        assert await _album(p, a) == []
        async with household_session(a.household_id) as db:
            tomb = (
                await db.execute(
                    text(
                        "SELECT object_key, thumb_key, backup_purged_at FROM photo_deletions "
                        "WHERE photo_id = :p"
                    ),
                    {"p": photo_id},
                )
            ).one()
            reactions = await db.scalar(
                text("SELECT count(*) FROM photo_reactions WHERE photo_id = :p"), {"p": photo_id}
            )
        assert (tomb.object_key, tomb.thumb_key, tomb.backup_purged_at) == (key, thumb, None)
        assert reactions == 0
        assert await _audit(a, photo_id) == ["photo.deleted"]

        # Gone is gone.
        assert (await _send(admin, "DELETE", f"{_base(sid)}/{photo_id}")).status_code == 404


async def test_delete_with_storage_down_rolls_back(two_households: Pair, fake: FakeStorage) -> None:
    a, _ = two_households
    async with phone() as p, phone() as admin:
        photo_id = await _ready_photo(p, a, fake, await _member(p, a))
        await _host(admin, a, "admin")
        with storage(DownStorage()):
            resp = await _send(admin, "DELETE", f"{_base(a.ids['session'])}/{photo_id}")
        assert resp.status_code == 503
        assert (await _photo_row(a, photo_id)).status == "ready"
        async with household_session(a.household_id) as db:
            tombs = await db.scalar(
                text("SELECT count(*) FROM photo_deletions WHERE photo_id = :p"), {"p": photo_id}
            )
        assert tombs == 0
        assert await _audit(a, photo_id) == []
