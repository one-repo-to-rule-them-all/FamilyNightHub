"""Games: Thanksgiving Bingo end to end (ADR-0018, slice B)."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from httpx import Response

from app.core.config import settings
from app.domain.games import bingo
from app.services import consent_service
from tests.integration.phones import Phone, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_voting import _host, _night, _person, _phone_for, _rows, _send

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
GAMES = "/api/v1/games"


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    yield


async def _bingo(host: Phone, *, start: bool = True, **config: Any) -> str:
    resp = await host.post(GAMES, {"kind": "bingo", "title": "Bingo", **config})
    assert resp.status_code == 201, resp.text
    assert resp.json()["status"] == "draft"
    gid = str(resp.json()["id"])
    if start:
        assert (await _send(host, "POST", f"{GAMES}/{gid}/open")).status_code == 200
    return gid


@asynccontextmanager
async def _player(
    h: SeededHousehold, host: Phone, name: str = "Sam"
) -> AsyncIterator[tuple[Phone, uuid.UUID]]:
    _, code, _ = await _night(host, 2)
    person = await _person(h, name)
    async with phone() as p:
        await _phone_for(p, h, code, person)
        yield p, person


async def _join(p: Phone, gid: str, person: uuid.UUID, seed: str = "1") -> Response:
    return await p.client.post(
        f"{GAMES}/{gid}/bingo/join",
        json={"person_id": str(person)},
        headers={"X-FNH-CSRF": await p.csrf(), "X-FNH-Test-Seed": seed},
    )


async def _mark(p: Phone, gid: str, person: uuid.UUID, index: int, method: str = "PUT") -> Response:
    return await _send(p, method, f"{GAMES}/{gid}/bingo/mark/{index}?person_id={person}")


async def _start(host: Phone, gid: str) -> None:
    resp = await _send(host, "POST", f"{GAMES}/{gid}/start")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "live"


async def test_host_runs_a_round_and_a_player_gets_a_private_card(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _bingo(host)
        async with _player(a, host) as (p, sam):
            joined = await _join(p, gid, sam)
            assert joined.status_code == 200, joined.text
            card = joined.json()
            assert len(card["squares"]) == 25 and card["squares"][12] == "FREE"
            assert len(set(card["squares"])) == 25
            assert card["marked"] == [12] and card["won"] is False
            # Joining again is the same card, not a new one.
            again = (await _join(p, gid, sam, seed="99")).json()
            assert again["squares"] == card["squares"]
            assert len(await _rows(a, "SELECT 1 FROM bingo_cards WHERE game_id = :g", g=gid)) == 1
            assert len(await _rows(a, "SELECT 1 FROM game_players WHERE game_id = :g", g=gid)) == 1
            mine = (await p.client.get(f"{GAMES}/{gid}/bingo/mine")).json()
            assert [c["squares"] for c in mine] == [card["squares"]]

            # The snapshot shows progress only: never squares, marks or a card.
            snap = (await host.client.get(f"{GAMES}/{gid}")).json()
            (player,) = snap["bingo"]["players"]
            assert player["person_id"] == str(sam) and player["squares_from_bingo"] == 4
            assert all(sq not in str(snap) for sq in card["squares"] if sq != "FREE")
            assert "marked" not in str(snap) and 'squares"' not in str(snap)


async def test_lifecycle_is_host_only_and_ordered(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host, phone() as nobody:
        await _host(host, a)
        gid = await _bingo(host, start=False)
        async with _player(a, host) as (p, sam):
            # A draft takes no players and no marks; a player cannot run it.
            assert (await _join(p, gid, sam)).status_code == 409
            assert (await _send(host, "POST", f"{GAMES}/{gid}/start")).status_code == 409
            assert (await _send(p, "POST", f"{GAMES}/{gid}/open")).status_code in (401, 403)
            assert (await _send(nobody, "POST", f"{GAMES}/{gid}/open")).status_code == 401
            assert (await _send(host, "POST", f"{GAMES}/{gid}/open")).status_code == 200
            assert (await _send(host, "POST", f"{GAMES}/{gid}/open")).status_code == 200
            assert (await _join(p, gid, sam)).status_code == 200
            # Open but not live: no marking yet.
            assert (await _mark(p, gid, sam, 0)).status_code == 409
            await _start(host, gid)
            assert (await _send(host, "POST", f"{GAMES}/{gid}/start")).status_code == 409
            assert (await _send(host, "POST", f"{GAMES}/{gid}/open")).status_code == 409
            ended = await _send(host, "POST", f"{GAMES}/{gid}/end")
            assert ended.json()["status"] == "ended"
            assert (await _mark(p, gid, sam, 0)).status_code == 409
            late = await _person(a, "Late")
            assert (await _join(p, gid, late)).status_code == 403  # not this phone's person
            # Jar-only routes do not reach a bingo game.
            assert (await host.client.get(f"{GAMES}/{gid}/jar/moderation")).status_code == 404


async def test_marking_is_own_card_idempotent_and_the_free_centre_stays(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _bingo(host)
        async with _player(a, host) as (p, sam), _player(a, host, "Kim") as (q, kim):
            await _join(p, gid, sam)
            await _join(q, gid, kim)
            await _start(host, gid)
            first = (await _mark(p, gid, sam, 0)).json()
            assert first["marked"] == [0, 12] and first["squares_from_bingo"] == 3
            assert (await _mark(p, gid, sam, 0)).json()["marked"] == [0, 12]  # idempotent
            assert (await _mark(p, gid, sam, 0, "DELETE")).json()["marked"] == [12]
            assert (await _mark(p, gid, sam, 0, "DELETE")).json()["marked"] == [12]
            assert (await _mark(p, gid, sam, 12, "DELETE")).json()["marked"] == [12]
            # Someone else's phone cannot mark my card; out-of-range indexes are refused.
            assert (await _mark(q, gid, sam, 1)).status_code == 403
            assert (await _mark(p, gid, sam, 25)).status_code == 422
            assert (await _mark(p, gid, sam, -1)).status_code == 422
            stranger = await _person(a, "Stranger")
            assert (await _mark(p, gid, stranger, 1)).status_code == 403
            # The phone with no card gets 404 on its own person.
            async with _player(a, host, "Nocard") as (r, nc):
                assert (await _mark(r, gid, nc, 1)).status_code == 404
            # Kim's card is untouched by Sam's marks.
            assert (await q.client.get(f"{GAMES}/{gid}/bingo/mine")).json()[0]["marked"] == [12]


async def test_completing_a_line_wins_and_ends_the_round(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _bingo(host)
        async with _player(a, host) as (p, sam), _player(a, host, "Kim") as (q, kim):
            await _join(p, gid, sam)
            await _join(q, gid, kim)
            await _start(host, gid)
            for i in range(4):
                assert (await _mark(p, gid, sam, i)).json()["won"] is False
            won = (await _mark(p, gid, sam, 4)).json()
            assert won["won"] is True and won["finish_place"] == 1
            snap = (await host.client.get(f"{GAMES}/{gid}")).json()
            assert snap["status"] == "ended"
            by = {x["person_id"]: x for x in snap["bingo"]["players"]}
            assert by[str(sam)]["won"] is True and by[str(sam)]["squares_from_bingo"] == 0
            assert by[str(kim)]["won"] is False
            # Round over: Kim can't mark any more.
            assert (await _mark(q, gid, kim, 0)).status_code == 409


async def test_blackout_needs_every_square_and_the_round_can_keep_going(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _bingo(host, win_mode="blackout", end_on_first_win=False)
        async with _player(a, host) as (p, sam):
            await _join(p, gid, sam)
            await _start(host, gid)
            # A full row is not a win in blackout.
            for i in range(5):
                assert (await _mark(p, gid, sam, i)).json()["won"] is False
            for i in range(5, 24):
                assert (await _mark(p, gid, sam, i)).json()["won"] is False
            assert (await _mark(p, gid, sam, 24)).json()["won"] is True
            snap = (await host.client.get(f"{GAMES}/{gid}")).json()
            assert snap["status"] == "live"  # end_on_first_win is off
            # The win is recorded; taking a mark back does not undo it.
            assert (await _mark(p, gid, sam, 3, "DELETE")).json()["won"] is True


async def test_without_a_free_centre_every_square_is_blank(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _bingo(host, free_center=False)
        async with _player(a, host) as (p, sam):
            card = (await _join(p, gid, sam)).json()
            assert "FREE" not in card["squares"] and card["marked"] == []
            await _start(host, gid)
            assert (await _mark(p, gid, sam, 12)).json()["marked"] == [12]
            assert (await _mark(p, gid, sam, 12, "DELETE")).json()["marked"] == []


async def test_simultaneous_completing_marks_yield_one_first_winner(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _bingo(host)
        async with _player(a, host) as (p, sam), _player(a, host, "Kim") as (q, kim):
            await _join(p, gid, sam)
            await _join(q, gid, kim)
            await _start(host, gid)
            for i in range(4):
                await _mark(p, gid, sam, i)
                await _mark(q, gid, kim, i)
            r1, r2 = await asyncio.gather(_mark(p, gid, sam, 4), _mark(q, gid, kim, 4))
            assert sorted([r1.status_code, r2.status_code]) == [200, 409]
            rows = await _rows(a, "SELECT person_id FROM bingo_cards WHERE won_at IS NOT NULL")
            assert len(rows) == 1


async def test_simultaneous_wins_keep_a_finishing_order_when_the_round_continues(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _bingo(host, end_on_first_win=False)
        async with _player(a, host) as (p, sam), _player(a, host, "Kim") as (q, kim):
            await _join(p, gid, sam)
            await _join(q, gid, kim)
            await _start(host, gid)
            for i in range(4):
                await _mark(p, gid, sam, i)
                await _mark(q, gid, kim, i)
            r1, r2 = await asyncio.gather(_mark(p, gid, sam, 4), _mark(q, gid, kim, 4))
            assert r1.status_code == 200 and r2.status_code == 200
            places = sorted([r1.json()["finish_place"], r2.json()["finish_place"]])
            # Each response is read inside its own transaction, so a place may be 1 or 2
            # there; the snapshot is the truth.
            assert set(places) <= {1, 2}
            snap = (await host.client.get(f"{GAMES}/{gid}")).json()
            assert sorted(x["finish_place"] for x in snap["bingo"]["players"]) == [1, 2]


async def test_consent_is_required_to_join(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _bingo(host)
        async with _player(a, host) as (p, sam):
            monkeypatch.setattr(consent_service, "TERMS_VERSION", "2099-01-01")
            assert (await _join(p, gid, sam)).status_code == 409  # ConsentRequired


async def test_another_household_cannot_see_play_or_run_a_bingo_game(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as host_a, phone() as host_b:
        await _host(host_a, a)
        await _host(host_b, b)
        gid = await _bingo(host_a)
        for method, path in (
            ("GET", f"{GAMES}/{gid}"),
            ("POST", f"{GAMES}/{gid}/open"),
            ("POST", f"{GAMES}/{gid}/start"),
            ("POST", f"{GAMES}/{gid}/end"),
        ):
            resp = await _send(host_b, method, path)
            assert resp.status_code == 404, (method, path)
        async with _player(b, host_b) as (pb, bob):
            assert (await _join(pb, gid, bob)).status_code == 404
            assert (await _mark(pb, gid, bob, 1)).status_code == 404
            assert (await pb.client.get(f"{GAMES}/{gid}/bingo/mine")).status_code == 404


async def test_merging_keeps_the_target_card_and_removing_a_person_erases_theirs(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host, phone() as admin:
        await _host(host, a)
        admin.sign_in_as(a.ids["account"], a.household_id)
        gid = await _bingo(host)
        async with _player(a, host, "Dupe") as (p, dupe), _player(a, host, "Keeper") as (q, keep):
            src = (await _join(p, gid, dupe)).json()
            dst = (await _join(q, gid, keep)).json()
            merge = {"from_person_id": str(dupe), "into_person_id": str(keep)}
            assert (await admin.post("/api/v1/admin/people/merge", merge)).status_code == 200
            rows = await _rows(
                a, "SELECT person_id, squares FROM bingo_cards WHERE game_id = :g", g=gid
            )
            assert [(r.person_id, list(r.squares)) for r in rows] == [(keep, dst["squares"])]
            assert src["squares"] != dst["squares"]

            resp = await admin.client.delete(
                f"/api/v1/admin/people/{keep}", headers={"X-FNH-CSRF": await admin.csrf()}
            )
            assert resp.status_code == 200, resp.text
            assert await _rows(a, "SELECT 1 FROM bingo_cards WHERE game_id = :g", g=gid) == []


async def test_a_card_only_moves_when_the_target_has_none(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host, phone() as admin:
        await _host(host, a)
        admin.sign_in_as(a.ids["account"], a.household_id)
        gid = await _bingo(host)
        async with _player(a, host, "Dupe") as (p, dupe):
            card = (await _join(p, gid, dupe)).json()
            keep = await _person(a, "Keeper")
            merge = {"from_person_id": str(dupe), "into_person_id": str(keep)}
            assert (await admin.post("/api/v1/admin/people/merge", merge)).status_code == 200
            rows = await _rows(
                a, "SELECT person_id, squares FROM bingo_cards WHERE game_id = :g", g=gid
            )
            assert [(r.person_id, list(r.squares)) for r in rows] == [(keep, card["squares"])]


async def test_the_export_includes_bingo_cards(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as admin:
        admin.sign_in_as(a.ids["account"], a.household_id)
        resp = await admin.client.get("/api/v1/admin/export")
        assert resp.status_code == 200
        import io
        import zipfile

        names = zipfile.ZipFile(io.BytesIO(resp.content)).namelist()
        assert "tables/bingo_cards.json" in names


def test_the_pool_can_fill_a_card() -> None:
    from app.domain.games import bingo_pool

    assert len(set(bingo_pool.THANKSGIVING_POOL)) >= bingo.CELLS
