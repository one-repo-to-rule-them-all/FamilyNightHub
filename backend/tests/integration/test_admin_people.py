"""Admin people: add, edit, guests, merge (ADR-0002; 05-data.md: merged, never deleted)."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import text

from app.core.database import household_session
from app.core.security import CSRF_HEADER
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "ADM234"
PEOPLE = "/api/v1/admin/people"


def _as_admin(p: Phone, h: SeededHousehold) -> None:
    p.sign_in_as(h.ids["account"], h.household_id)


async def _create(p: Phone, name: str, **extra: Any) -> Response:
    body = {"name": name, "avatar_emoji": "🐙", "color": "#3366CC", **extra}
    return await p.post(PEOPLE, body)


async def _new_person(p: Phone, name: str, **extra: Any) -> uuid.UUID:
    resp = await _create(p, name, **extra)
    assert resp.status_code == 201, resp.text
    return uuid.UUID(resp.json()["id"])


async def _sql(house: SeededHousehold, sql: str, **params: Any) -> list[Any]:
    async with household_session(house.household_id) as db:
        result: Any = await db.execute(text(sql), params)
        return list(result.all()) if result.returns_rows else []


# --- Create / permissions -----------------------------------------------------------


async def test_admin_adds_a_member(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        _as_admin(p, a)
        resp = await _create(p, "  Abuela   Rosa ")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["name"] == "Abuela Rosa"
        assert body["color"] == "#3366cc"
        assert body["is_guest"] is False
        listed = (await p.client.get(PEOPLE)).json()
    assert "Abuela Rosa" in [x["name"] for x in listed]
    audit = await _sql(
        a, "SELECT action FROM audit_events WHERE target_id = :p", p=uuid.UUID(body["id"])
    )
    assert [r.action for r in audit] == ["person.created"]


async def test_host_may_add_a_guest_but_not_a_member(two_households: Pair) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", f"host.{a.slug}@example.test")
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        assert (await _create(p, "Cousin Leo")).status_code == 403
        guest = await _create(p, "Cousin Leo", is_guest=True)
        assert guest.status_code == 201
        assert guest.json()["is_guest"] is True
        # Everything else in the people admin is admin-only.
        assert (await p.client.get(PEOPLE)).status_code == 403
        merge = {"from_person_id": guest.json()["id"], "into_person_id": str(a.ids["person"])}
        assert (await p.post(f"{PEOPLE}/merge", merge)).status_code == 403


async def test_a_device_cookie_alone_is_not_enough(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        assert (await p.join(a.slug, CODE)).status_code == 200
        assert (await p.client.get(PEOPLE)).status_code == 401
        assert (await _create(p, "Nope", is_guest=True)).status_code == 401
        resp = await p.patch(f"{PEOPLE}/{a.ids['person']}", {"name": "Hacked"})
        assert resp.status_code == 401


async def test_mutations_need_the_csrf_header(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        _as_admin(p, a)
        await p.csrf()
        body = {"name": "Sneaky", "avatar_emoji": "🐍", "color": "#000000"}
        assert (await p.client.post(PEOPLE, json=body)).status_code == 403
        bad = {CSRF_HEADER: "wrong"}
        assert (await p.client.post(PEOPLE, json=body, headers=bad)).status_code == 403
        resp = await p.client.patch(f"{PEOPLE}/{a.ids['person']}", json={"name": "X"})
        assert resp.status_code == 403
        resp = await p.client.post(f"{PEOPLE}/{a.ids['person']}/convert-to-member")
        assert resp.status_code == 403


@pytest.mark.parametrize(
    "override",
    [
        {"name": "   "},
        {"name": "x" * 61},
        {"avatar_emoji": "cat"},
        {"avatar_emoji": "🐱 🐶"},
        {"avatar_emoji": "🐱" * 17},
        {"avatar_emoji": ""},
        {"color": "red"},
        {"color": "#12345"},
        {"color": "#gg0000"},
    ],
)
async def test_invalid_person_is_rejected(two_households: Pair, override: dict[str, str]) -> None:
    a, _ = two_households
    async with phone() as p:
        _as_admin(p, a)
        body = {"name": "Valid", "avatar_emoji": "🐙", "color": "#336699", **override}
        assert (await p.post(PEOPLE, body)).status_code == 422


async def test_family_emoji_and_keycaps_are_avatars(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        _as_admin(p, a)
        assert (await _create(p, "Family", avatar_emoji="👨‍👩‍👧‍👦")).status_code == 201
        assert (await _create(p, "Number One", avatar_emoji="1️⃣")).status_code == 201


async def test_names_are_unique_case_insensitively_among_live_people(
    two_households: Pair,
) -> None:
    a, b = two_households
    async with phone() as p:
        _as_admin(p, a)
        sam = await _new_person(p, "Sam")
        resp = await _create(p, "sAM", is_guest=True)
        assert resp.status_code == 409
        assert "Sam" in resp.json()["error"]["message"]
        # The seeded "Kid" can't be renamed onto Sam either...
        resp = await p.patch(f"{PEOPLE}/{a.ids['person']}", {"name": "SAM"})
        assert resp.status_code == 409
        # ...but Sam can change their own capitalisation.
        assert (await p.patch(f"{PEOPLE}/{sam}", {"name": "SAM"})).status_code == 200
        # Once merged away, a name is free again.
        merge = {"from_person_id": str(sam), "into_person_id": str(a.ids["person"])}
        assert (await p.post(f"{PEOPLE}/merge", merge)).status_code == 200
        assert (await _create(p, "Sam")).status_code == 201
    # Names are per household.
    async with phone() as p:
        _as_admin(p, b)
        assert (await _create(p, "Sam")).status_code == 201


# --- Edit / guests ------------------------------------------------------------------


async def test_admin_renames_and_restyles(two_households: Pair) -> None:
    a, _ = two_households
    pid = a.ids["person"]
    async with phone() as p:
        _as_admin(p, a)
        resp = await p.patch(f"{PEOPLE}/{pid}", {"name": "Mateo"})
        assert resp.status_code == 200
        assert resp.json()["avatar_emoji"] == "🦖"  # untouched
        resp = await p.patch(f"{PEOPLE}/{pid}", {"avatar_emoji": "🦊", "color": "#ABCDEF"})
        assert resp.json() | {"created_at": None} == {
            "id": str(pid),
            "name": "Mateo",
            "avatar_emoji": "🦊",
            "color": "#abcdef",
            "is_guest": False,
            "created_at": None,
        }
        assert (await p.patch(f"{PEOPLE}/{pid}", {"color": "blue"})).status_code == 422
    audit = await _sql(
        a,
        "SELECT data FROM audit_events WHERE target_id = :p AND action = 'person.updated' "
        "ORDER BY created_at",
        p=pid,
    )
    assert [r.data["fields"] for r in audit] == [["name"], ["avatar_emoji", "color"]]


async def test_other_household_people_are_404(two_households: Pair) -> None:
    a, b = two_households
    theirs = b.ids["person"]
    async with phone() as p:
        _as_admin(p, a)
        assert (await p.patch(f"{PEOPLE}/{theirs}", {"name": "Mine"})).status_code == 404
        assert (await p.post(f"{PEOPLE}/{theirs}/convert-to-member")).status_code == 404
        assert (await p.patch(f"{PEOPLE}/{uuid.uuid4()}", {"name": "Ghost"})).status_code == 404
        cross = {"from_person_id": str(theirs), "into_person_id": str(a.ids["person"])}
        assert (await p.post(f"{PEOPLE}/merge", cross)).status_code == 404
        cross = {"from_person_id": str(a.ids["person"]), "into_person_id": str(theirs)}
        assert (await p.post(f"{PEOPLE}/merge", cross)).status_code == 404
    rows = await _sql(b, "SELECT name, merged_into_id FROM people WHERE id = :p", p=theirs)
    assert rows[0].name == "Kid" and rows[0].merged_into_id is None


async def test_guests_list_and_convert_to_member(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        _as_admin(p, a)
        guest = await _new_person(p, "Neighbour Ana", is_guest=True)
        guests = (await p.client.get(PEOPLE, params={"guests_only": "true"})).json()
        assert [g["id"] for g in guests] == [str(guest)]
        resp = await p.post(f"{PEOPLE}/{guest}/convert-to-member")
        assert resp.status_code == 200
        assert resp.json()["is_guest"] is False
        # Idempotent, and only one audit row.
        assert (await p.post(f"{PEOPLE}/{guest}/convert-to-member")).status_code == 200
        assert (await p.client.get(PEOPLE, params={"guests_only": "true"})).json() == []
    audit = await _sql(
        a,
        "SELECT 1 FROM audit_events WHERE target_id = :p AND action = 'person.converted_to_member'",
        p=guest,
    )
    assert len(audit) == 1


# --- Merge --------------------------------------------------------------------------


async def _night(h: SeededHousehold) -> tuple[uuid.UUID, list[uuid.UUID]]:
    """A second night with three options."""
    async with household_session(h.household_id) as db:
        session_id: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO sessions (household_id, night_code_hash, status) "
                    "VALUES (:h, :c, 'closed') RETURNING id"
                ),
                {"h": h.household_id, "c": f"m{uuid.uuid4().hex}"},
            )
        ).scalar_one()
        options = []
        for title in ("Coco", "Moana", "Wall-E"):
            movie = (
                await db.execute(
                    text("INSERT INTO movies (household_id, title) VALUES (:h, :t) RETURNING id"),
                    {"h": h.household_id, "t": f"{title} {uuid.uuid4().hex[:6]}"},
                )
            ).scalar_one()
            options.append(
                (
                    await db.execute(
                        text(
                            "INSERT INTO options (household_id, session_id, movie_id) "
                            "VALUES (:h, :s, :m) RETURNING id"
                        ),
                        {"h": h.household_id, "s": session_id, "m": movie},
                    )
                ).scalar_one()
            )
    return session_id, options


async def _ballot(
    h: SeededHousehold, session_id: uuid.UUID, person: uuid.UUID, options: list[uuid.UUID]
) -> None:
    async with household_session(h.household_id) as db:
        for rank, option in enumerate(options, start=1):
            await db.execute(
                text(
                    "INSERT INTO ballot_ranks (household_id, session_id, person_id, option_id, "
                    "rank, cast_by_device_id) VALUES (:h, :s, :p, :o, :r, :d)"
                ),
                {
                    "h": h.household_id,
                    "s": session_id,
                    "p": person,
                    "o": option,
                    "r": rank,
                    "d": h.ids["device"],
                },
            )


async def _merge(p: Phone, src: uuid.UUID, dst: uuid.UUID) -> Response:
    return await p.post(f"{PEOPLE}/merge", {"from_person_id": str(src), "into_person_id": str(dst)})


async def test_merge_without_collisions_moves_everything(two_households: Pair) -> None:
    """The seeded Kid owns a ballot rank, a rating, a photo, a reaction and a binding."""
    a, _ = two_households
    kid = a.ids["person"]
    async with phone() as p:
        _as_admin(p, a)
        target = await _new_person(p, "Mateo")
        resp = await _merge(p, kid, target)
        assert resp.status_code == 200, resp.text
        body = resp.json()
    assert body["person"]["id"] == str(target)
    assert body["merged_from_id"] == str(kid)
    counts = {k: v for k, v in body.items() if k.endswith(("_moved", "_dropped"))}
    assert counts == {
        "ballot_ranks_moved": 1,
        "ballot_ranks_dropped": 0,
        "ratings_moved": 1,
        "ratings_dropped": 0,
        "photos_moved": 1,
        "reactions_moved": 1,
        "reactions_dropped": 0,
        "bindings_moved": 1,
        "bindings_dropped": 0,
    }
    for table in ("ballot_ranks", "ratings", "photos", "photo_reactions", "device_people"):
        owners = await _sql(a, f"SELECT person_id FROM {table}")
        assert {r.person_id for r in owners} == {target}, table
    # Merged, not deleted.
    rows = await _sql(a, "SELECT merged_into_id FROM people WHERE id = :p", p=kid)
    assert rows[0].merged_into_id == target
    audit = await _sql(a, "SELECT target_id, data FROM audit_events WHERE action = 'person.merged'")
    assert len(audit) == 1
    assert audit[0].target_id == target
    assert audit[0].data["from"] == str(kid)


async def test_merge_keeps_the_targets_ballot_when_both_voted_the_same_night(
    two_households: Pair,
) -> None:
    a, _ = two_households
    kid, seeded_night = a.ids["person"], a.ids["session"]
    other_night, opts = await _night(a)
    async with phone() as p:
        _as_admin(p, a)
        target = await _new_person(p, "Mateo")
        # Both ranked in the seeded night (kid: option #1 at rank 1; target: option2 at
        # rank 1 and option at rank 2: same ranks and same options collide both ways).
        await _ballot(a, seeded_night, target, [a.ids["option2"], a.ids["option"]])
        # Only the kid voted in the other night: that ballot moves whole.
        await _ballot(a, other_night, kid, opts)
        body = (await _merge(p, kid, target)).json()
    assert (body["ballot_ranks_moved"], body["ballot_ranks_dropped"]) == (3, 1)
    seeded = await _sql(
        a,
        "SELECT option_id, rank FROM ballot_ranks WHERE session_id = :s ORDER BY rank",
        s=seeded_night,
    )
    assert [(r.option_id, r.rank) for r in seeded] == [(a.ids["option2"], 1), (a.ids["option"], 2)]
    moved = await _sql(
        a,
        "SELECT person_id, option_id FROM ballot_ranks WHERE session_id = :s ORDER BY rank",
        s=other_night,
    )
    assert [(r.person_id, r.option_id) for r in moved] == [(target, o) for o in opts]


async def test_merge_keeps_the_targets_rating(two_households: Pair) -> None:
    a, _ = two_households
    kid = a.ids["person"]
    other_night, _ = await _night(a)
    async with phone() as p:
        _as_admin(p, a)
        target = await _new_person(p, "Mateo")
        await _sql(
            a,
            "INSERT INTO ratings (household_id, session_id, person_id, score) "
            "VALUES (:h, :s, :p, 2)",
            h=a.household_id,
            s=a.ids["session"],
            p=target,
        )
        await _sql(
            a,
            "INSERT INTO ratings (household_id, session_id, person_id, score) "
            "VALUES (:h, :s, :p, 4)",
            h=a.household_id,
            s=other_night,
            p=kid,
        )
        body = (await _merge(p, kid, target)).json()
    assert (body["ratings_moved"], body["ratings_dropped"]) == (1, 1)
    rows = await _sql(a, "SELECT session_id, person_id, score FROM ratings")
    assert {(r.session_id, r.person_id, r.score) for r in rows} == {
        (a.ids["session"], target, 2),  # the target's 2, not the kid's seeded 5
        (other_night, target, 4),
    }


async def test_merge_dedupes_reactions(two_households: Pair) -> None:
    a, _ = two_households
    kid, photo = a.ids["person"], a.ids["photo"]
    async with phone() as p:
        _as_admin(p, a)
        target = await _new_person(p, "Mateo")
        # The kid already reacted ❤️ (seed). Target also reacted ❤️; kid also 😂.
        for person, emoji in ((target, "❤️"), (kid, "😂")):
            await _sql(
                a,
                "INSERT INTO photo_reactions (household_id, photo_id, person_id, emoji) "
                "VALUES (:h, :ph, :p, :e)",
                h=a.household_id,
                ph=photo,
                p=person,
                e=emoji,
            )
        body = (await _merge(p, kid, target)).json()
    assert (body["reactions_moved"], body["reactions_dropped"]) == (1, 1)
    rows = await _sql(a, "SELECT person_id, emoji FROM photo_reactions ORDER BY emoji")
    assert sorted((r.person_id, r.emoji) for r in rows) == sorted([(target, "❤️"), (target, "😂")])


async def test_merge_keeps_the_targets_binding_and_the_stronger_status(
    two_households: Pair,
) -> None:
    """The seeded device holds Kid (active). Target has a *pending* claim on the same
    device, and an active binding on a second device the kid is pending on."""
    a, _ = two_households
    kid, device = a.ids["person"], a.ids["device"]
    async with phone() as p:
        _as_admin(p, a)
        target = await _new_person(p, "Mateo")
        second = (
            await _sql(
                a,
                "INSERT INTO devices (household_id, token_hash) VALUES (:h, :t) RETURNING id",
                h=a.household_id,
                t=f"t{uuid.uuid4().hex}",
            )
        )[0].id
        for d, person, st in (
            (device, target, "pending"),
            (second, target, "active"),
            (second, kid, "pending"),
        ):
            await _sql(
                a,
                "INSERT INTO device_people (household_id, device_id, person_id, status) "
                "VALUES (:h, :d, :p, :s)",
                h=a.household_id,
                d=d,
                p=person,
                s=st,
            )
        body = (await _merge(p, kid, target)).json()
    assert (body["bindings_moved"], body["bindings_dropped"]) == (0, 2)
    rows = await _sql(a, "SELECT device_id, person_id, status FROM device_people")
    assert {(r.device_id, r.person_id, r.status) for r in rows} == {
        (device, target, "active"),  # was pending; the kid's active binding upgrades it
        (second, target, "active"),  # never downgraded by the kid's pending claim
    }


async def test_merge_refusals(two_households: Pair) -> None:
    a, _ = two_households
    kid = a.ids["person"]
    async with phone() as p:
        _as_admin(p, a)
        resp = await _merge(p, kid, kid)
        assert resp.status_code == 409
        target = await _new_person(p, "Mateo")
        assert (await _merge(p, kid, target)).status_code == 200
        # The source is gone now, as source or as target.
        assert (await _merge(p, kid, target)).status_code == 404
        assert (await _merge(p, target, kid)).status_code == 404
        assert (await p.patch(f"{PEOPLE}/{kid}", {"name": "Back"})).status_code == 404
        assert (await _merge(p, uuid.uuid4(), target)).status_code == 404


async def test_merged_people_disappear_and_chains_stay_one_hop(two_households: Pair) -> None:
    a, _ = two_households
    kid = a.ids["person"]
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as admin:
        _as_admin(admin, a)
        middle = await _new_person(admin, "Teo", is_guest=True)
        final = await _new_person(admin, "Mateo")
        assert (await _merge(admin, kid, middle)).status_code == 200
        assert (await _merge(admin, middle, final)).status_code == 200
        admin_names = [x["name"] for x in (await admin.client.get(PEOPLE)).json()]
    assert "Kid" not in admin_names and "Teo" not in admin_names
    rows = await _sql(
        a, "SELECT id, merged_into_id FROM people WHERE id IN (:k, :m)", k=kid, m=middle
    )
    assert {r.id: r.merged_into_id for r in rows} == {kid: final, middle: final}
    async with phone() as kid_phone:
        assert (await kid_phone.join(a.slug, CODE)).status_code == 200
        grid = (await kid_phone.client.get("/api/v1/people")).json()
        assert [t["name"] for t in grid] == ["Mateo"]
        # A merged id cannot be claimed either.
        assert (await kid_phone.bind(kid)).status_code == 404
