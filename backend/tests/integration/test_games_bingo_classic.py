"""Games: classic host-called bingo end to end (ADR-0018 amendment 2026-11-25, part A)."""

from __future__ import annotations

import asyncio
import io
import uuid
import zipfile
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest

from app.core.config import settings
from app.domain.games import bingo_classic
from app.realtime import events as rt_events
from app.services import games_service
from tests.integration.phones import Phone, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_voting import _host, _night, _person, _phone_for, _rows, _send

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
GAMES = "/api/v1/games"
SEED = 12345
TEST_SEED = "X-FNH-Test-Seed"


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    yield


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    seen: list[tuple[str, str]] = []
    original = games_service.publish_game_after_commit

    def record(db: Any, game_id: uuid.UUID, kind: str) -> None:
        seen.append((str(game_id), kind))
        original(db, game_id, kind)

    monkeypatch.setattr(games_service, "publish_game_after_commit", record)
    return seen


async def _classic(host: Phone, *, seed: int = SEED, **config: Any) -> str:
    resp = await host.post(GAMES, {"kind": "bingo", "title": "Bingo", "mode": "classic", **config})
    assert resp.status_code == 201, resp.text
    gid = str(resp.json()["id"])
    opened = await _send(host, "POST", f"{GAMES}/{gid}/open", **{TEST_SEED: str(seed)})
    assert opened.status_code == 200, opened.text
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


async def _join(p: Phone, gid: str, person: uuid.UUID) -> list[str]:
    resp = await _send(p, "POST", f"{GAMES}/{gid}/bingo/join", {"person_id": str(person)})
    assert resp.status_code == 200, resp.text
    squares: list[str] = resp.json()["squares"]
    return squares


async def _start(host: Phone, gid: str) -> None:
    assert (await _send(host, "POST", f"{GAMES}/{gid}/start")).status_code == 200


async def _draw(host: Phone, gid: str, seq: int) -> Any:
    return await _send(host, "POST", f"{GAMES}/{gid}/bingo/draw", {"expected_seq": seq})


async def _draw_until(host: Phone, gid: str, have: int, values: set[int], seed: int = SEED) -> int:
    """Draw until every value in `values` is called; returns the new count."""
    order = bingo_classic.call_order(seed)
    need = max(order.index(v) for v in values) + 1
    for seq in range(have, need):
        assert (await _draw(host, gid, seq)).status_code == 200
    return max(need, have)


async def _check(host: Phone, gid: str, person: uuid.UUID) -> Any:
    return await _send(host, "POST", f"{GAMES}/{gid}/bingo/check", {"person_id": str(person)})


async def _mark(p: Phone, gid: str, person: uuid.UUID, index: int, method: str = "PUT") -> Any:
    return await _send(p, method, f"{GAMES}/{gid}/bingo/mark/{index}?person_id={person}")


def _row_values(squares: list[str], row: int) -> set[int]:
    return {int(s) for s in squares[row * 5 : row * 5 + 5] if s != "FREE"}


async def test_75_draws_never_repeat_and_follow_the_pinned_seed(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _classic(host)
        await _start(host, gid)
        for seq in range(75):
            resp = await _draw(host, gid, seq)
            assert resp.status_code == 200, resp.text
        snap = resp.json()["bingo"]
        assert [c["value"] for c in snap["calls"]] == bingo_classic.call_order(SEED)
        assert snap["last_call"]["seq"] == 74
        assert snap["last_call"]["label"] == bingo_classic.label(snap["last_call"]["value"])
        assert len({c["value"] for c in snap["calls"]}) == 75
        again = await _draw(host, gid, 75)
        assert again.status_code == 409 and "Every number" in again.json()["error"]["message"]
        # The seed never reaches a snapshot.
        assert "seed" not in str(resp.json()) and str(SEED) not in str(resp.json()["bingo"]["mode"])

        # A second game with the same pinned seed reproduces the whole game.
        other = await _classic(host)
        await _start(host, other)
        assert (await _draw(host, other, 0)).json()["bingo"]["calls"][0]["value"] == (
            bingo_classic.call_order(SEED)[0]
        )


async def test_open_keeps_the_seed_and_the_draw_waits_for_live(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _classic(host)
        # Opening again with another seed is idempotent and keeps the first.
        await _send(host, "POST", f"{GAMES}/{gid}/open", **{TEST_SEED: "999"})
        rows = await _rows(a, "SELECT reveal_seed FROM games WHERE id = :g", g=gid)
        assert int(rows[0].reveal_seed) == SEED
        assert (await _draw(host, gid, 0)).status_code == 409  # open, not live
        await _start(host, gid)
        assert (await _draw(host, gid, 0)).status_code == 200


async def test_a_stale_or_simultaneous_draw_inserts_nothing(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host, phone() as second:
        await _host(host, a)
        second.sign_in_as((await _rows(a, "SELECT id FROM accounts LIMIT 1"))[0].id, a.household_id)
        gid = await _classic(host)
        await _start(host, gid)
        assert (await _draw(host, gid, 3)).status_code == 409
        assert await _rows(a, "SELECT 1 FROM bingo_calls WHERE game_id = :g", g=gid) == []
        # Two windows drawing "the first number" at once: one wins, the other is told.
        first, dup = await asyncio.gather(_draw(host, gid, 0), _draw(host, gid, 0))
        assert sorted([first.status_code, dup.status_code]) == [200, 409]
        assert len(await _rows(a, "SELECT 1 FROM bingo_calls WHERE game_id = :g", g=gid)) == 1
        # Consecutive draws are consecutive seqs.
        assert (await _draw(host, gid, 1)).status_code == 200
        seqs = await _rows(a, "SELECT seq FROM bingo_calls WHERE game_id = :g ORDER BY seq", g=gid)
        assert [r.seq for r in seqs] == [0, 1]


async def test_marking_is_limited_to_called_numbers(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _classic(host)
        async with _player(a, host) as (p, sam):
            squares = await _join(p, gid, sam)
            assert squares[12] == "FREE"
            await _start(host, gid)
            first = bingo_classic.call_order(SEED)[0]
            await _draw(host, gid, 0)
            on_card = first in {int(s) for s in squares if s != "FREE"}
            other = next(i for i, s in enumerate(squares) if s != "FREE" and int(s) != first)
            blocked = await _mark(p, gid, sam, other)
            assert blocked.status_code == 409
            assert blocked.json()["error"]["message"] == "That number hasn't been called."
            if on_card:
                at = squares.index(str(first))
                ok = await _mark(p, gid, sam, at)
                assert ok.status_code == 200 and at in ok.json()["marked"]
                undone = await _mark(p, gid, sam, at, "DELETE")
                assert at not in undone.json()["marked"]
            # The free centre is always allowed and cannot be taken back.
            assert (await _mark(p, gid, sam, 12)).status_code == 200
            assert 12 in (await _mark(p, gid, sam, 12, "DELETE")).json()["marked"]


async def test_a_false_check_changes_nothing_and_a_true_one_wins(
    two_households: Pair, events: list[tuple[str, str]]
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _classic(host)
        async with _player(a, host) as (p, sam):
            squares = await _join(p, gid, sam)
            await _start(host, gid)
            await _draw(host, gid, 0)
            before = len(events)
            miss = await _check(host, gid, sam)
            assert miss.status_code == 200
            body = miss.json()
            assert body["valid"] is False and body["pattern"] is None and body["missing"] >= 1
            assert len(events) == before  # nothing published
            game = (await host.client.get(f"{GAMES}/{gid}")).json()
            assert game["status"] == "live"
            assert (await _rows(a, "SELECT won_at FROM bingo_cards WHERE game_id = :g", g=gid))[
                0
            ].won_at is None
            audits = await _rows(
                a, "SELECT data FROM audit_events WHERE action = 'game.bingo_checked'"
            )
            assert [r.data["valid"] for r in audits] == [False]

            # Call the whole top row; the player never tapped anything. It still checks valid.
            top = _row_values(squares, 0)
            await _draw_until(host, gid, 1, top)
            ok = await _check(host, gid, sam)
            assert ok.status_code == 200
            assert ok.json()["valid"] is True and ok.json()["missing"] == 0
            assert ok.json()["pattern"] is not None
            ended = (await host.client.get(f"{GAMES}/{gid}")).json()
            assert ended["status"] == "ended"
            (player,) = ended["bingo"]["players"]
            assert player["won"] is True and player["finish_place"] == 1
            assert (await _rows(a, "SELECT won_at FROM bingo_cards WHERE game_id = :g", g=gid))[
                0
            ].won_at is not None
            # The game is over: no further draws or checks.
            assert (await _check(host, gid, sam)).status_code == 409
            assert (await _draw(host, gid, 5)).status_code == 409


async def test_a_wrong_tap_cannot_win_and_play_goes_on_when_configured(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _classic(host, end_on_first_win=False)
        async with _player(a, host) as (p, sam), _player(a, host, "Kim") as (q, kim):
            squares = await _join(p, gid, sam)
            await _join(q, gid, kim)
            await _start(host, gid)
            await _draw_until(host, gid, 0, _row_values(squares, 2))
            first = await _check(host, gid, sam)
            assert first.json()["valid"] is True
            assert (await host.client.get(f"{GAMES}/{gid}")).json()["status"] == "live"
            won_at = (
                await _rows(
                    a, "SELECT won_at FROM bingo_cards WHERE game_id = :g ORDER BY won_at", g=gid
                )
            )[0].won_at
            # Checking a winner again is idempotent.
            assert (await _check(host, gid, sam)).json()["valid"] is True
            same = (
                await _rows(
                    a, "SELECT won_at FROM bingo_cards WHERE game_id = :g ORDER BY won_at", g=gid
                )
            )[0].won_at
            assert same == won_at
            # Kim's own check is whatever her card holds; no card for a stranger is 404.
            assert (await _check(host, gid, uuid.uuid4())).status_code == 404


async def test_blackout_needs_every_square(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _classic(host, win_mode="blackout")
        async with _player(a, host) as (p, sam):
            squares = await _join(p, gid, sam)
            await _start(host, gid)
            # Ten calls can never cover 24 numbers, whatever the card holds.
            drawn = await _draw_until(host, gid, 0, set(bingo_classic.call_order(SEED)[:10]))
            miss = (await _check(host, gid, sam)).json()
            assert miss["valid"] is False and miss["win_mode"] == "blackout"
            await _draw_until(host, gid, drawn, {int(s) for s in squares if s != "FREE"}, SEED)
            hit = (await _check(host, gid, sam)).json()
            assert hit["valid"] is True and hit["pattern"] == list(range(25))


async def test_thanksgiving_rejects_draw_and_check_and_stays_the_default(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        resp = await host.post(GAMES, {"kind": "bingo", "title": "Old school"})
        assert resp.json()["bingo"]["mode"] == "thanksgiving"
        assert resp.json()["bingo"]["calls"] == []
        gid = str(resp.json()["id"])
        await _send(host, "POST", f"{GAMES}/{gid}/open")
        await _start(host, gid)
        assert (await _draw(host, gid, 0)).status_code == 409
        denied = await _check(host, gid, uuid.uuid4())
        assert denied.status_code == 409 and "Thanksgiving" in denied.json()["error"]["message"]
        assert await _rows(a, "SELECT reveal_seed FROM games WHERE id = :g", g=gid) == [(None,)]


async def test_bad_mode_is_422_and_other_kinds_reject_draw(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        assert (
            await host.post(GAMES, {"kind": "bingo", "title": "x", "mode": "zz"})
        ).status_code == 422
        jar = await host.post(GAMES, {"kind": "gratitude_jar", "title": "Jar"})
        assert (await _draw(host, str(jar.json()["id"]), 0)).status_code == 404


async def test_guest_cannot_draw_and_snapshot_hides_the_future(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _classic(host)
        async with _player(a, host) as (p, sam):
            await _join(p, gid, sam)
            await _start(host, gid)
            assert (await _draw(p, gid, 0)).status_code in (401, 403)
            assert (await _check(p, gid, sam)).status_code in (401, 403)
            await _draw(host, gid, 0)
            snap = (await p.client.get(f"{GAMES}/{gid}")).json()
            assert len(snap["bingo"]["calls"]) == 1
            future = bingo_classic.call_order(SEED)[1:]
            assert snap["bingo"]["calls"][0]["value"] == bingo_classic.call_order(SEED)[0]
            assert str(snap).count("seed") == 0 and len(future) == 74


async def test_cross_household_is_404_and_the_export_lists_the_table(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as host, phone() as other:
        await _host(host, a)
        await _host(other, b)
        gid = await _classic(host)
        await _start(host, gid)
        assert (await _draw(other, gid, 0)).status_code == 404
        assert (await _check(other, gid, uuid.uuid4())).status_code == 404
        await _draw(host, gid, 0)
        assert await _rows(b, "SELECT 1 FROM bingo_calls WHERE game_id = :g", g=gid) == []
        host.sign_in_as(a.ids["account"], a.household_id)
        resp = await host.client.get("/api/v1/admin/export")
        assert resp.status_code == 200
        archive = zipfile.ZipFile(io.BytesIO(resp.content))
        assert "tables/bingo_calls.json" in archive.namelist()


async def test_the_games_list_says_which_kind_of_bingo(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        classic = await _classic(host)
        old = (await host.post(GAMES, {"kind": "bingo", "title": "Old school"})).json()["id"]
        jar = (await host.post(GAMES, {"kind": "gratitude_jar", "title": "Jar"})).json()["id"]
        modes = {g["id"]: g["mode"] for g in (await host.client.get(GAMES)).json()}
        assert modes[classic] == "classic"
        assert modes[old] == "thanksgiving"
        assert modes[jar] is None


async def _reroll(p: Phone, gid: str, person: uuid.UUID, seed: str | None = None) -> Any:
    headers = {TEST_SEED: seed} if seed is not None else {}
    return await _send(
        p, "POST", f"{GAMES}/{gid}/bingo/reroll", {"person_id": str(person)}, **headers
    )


async def test_reroll_swaps_only_my_card_and_keeps_columns_valid(
    two_households: Pair, events: list[tuple[str, str]]
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _classic(host)
        async with _player(a, host, "Sam") as (p, sam), _player(a, host, "Kim") as (q, kim):
            first = await _join(p, gid, sam)
            kims = await _join(q, gid, kim)
            seen = {tuple(first)}
            for _ in range(3):  # as many times as they like
                resp = await _reroll(p, gid, sam)
                assert resp.status_code == 200, resp.text
                new = resp.json()["squares"]
                assert tuple(new) not in seen
                seen.add(tuple(new))
                assert new[12] == "FREE" and resp.json()["marked"] == [12]
                for col in range(5):
                    vals = [int(new[col + 5 * r]) for r in range(5) if new[col + 5 * r] != "FREE"]
                    assert len(set(vals)) == len(vals)
                    assert all(col * 15 < v <= (col + 1) * 15 for v in vals)
            mine = (await p.client.get(f"{GAMES}/{gid}/bingo/mine")).json()
            assert mine[0]["squares"] == new
            assert (await q.client.get(f"{GAMES}/{gid}/bingo/mine")).json()[0]["squares"] == kims
            assert (gid, rt_events.GAME_ACTIVITY) in events


async def test_reroll_with_the_join_seed_pinned_still_differs(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _classic(host)
        async with _player(a, host) as (p, sam):
            resp = await _send(
                p, "POST", f"{GAMES}/{gid}/bingo/join", {"person_id": str(sam)}, **{TEST_SEED: "7"}
            )
            old = resp.json()["squares"]
            r1 = (await _reroll(p, gid, sam, "7")).json()["squares"]
            assert r1 != old
            assert (await _reroll(p, gid, sam, "7")).json()["squares"] != r1


async def test_reroll_resets_marks_and_is_refused_once_live_or_ended(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _classic(host)
        async with _player(a, host) as (p, sam):
            squares = await _join(p, gid, sam)
            assert (await _reroll(p, gid, sam)).status_code == 200
            await _start(host, gid)
            resp = await _reroll(p, gid, sam)
            assert resp.status_code == 409 and "started" in resp.text
            mine = (await p.client.get(f"{GAMES}/{gid}/bingo/mine")).json()[0]
            assert mine["squares"] != squares  # the earlier reroll stuck
            await _send(host, "POST", f"{GAMES}/{gid}/end")
            assert (await _reroll(p, gid, sam)).status_code == 409


async def test_reroll_refused_in_draft_for_others_and_across_households(
    two_households: Pair,
) -> None:
    a, b = two_households
    async with phone() as host, phone() as other:
        await _host(host, a)
        await _host(other, b)
        draft = (await host.post(GAMES, {"kind": "bingo", "title": "B", "mode": "classic"})).json()
        gid = await _classic(host)
        async with _player(a, host, "Sam") as (p, sam), _player(a, host, "Kim") as (q, kim):
            await _join(p, gid, sam)
            await _join(q, gid, kim)
            assert (await _reroll(p, draft["id"], sam)).status_code == 409
            assert (await _reroll(p, gid, kim)).status_code == 403  # not this phone's person
            async with _player(b, other, "Bob") as (pb, bob):
                assert (await _reroll(pb, gid, bob)).status_code == 404
