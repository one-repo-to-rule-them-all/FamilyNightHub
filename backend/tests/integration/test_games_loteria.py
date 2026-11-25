"""Games: Loteria end to end (ADR-0018 amendment 2026-11-26)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest

from app.core.config import settings
from app.domain.games import loteria
from app.services import loteria_service
from tests.integration.phones import Phone, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_voting import _host, _night, _person, _phone_for, _rows, _send

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
GAMES = "/api/v1/games"
SEED = 4242
TEST_SEED = "X-FNH-Test-Seed"


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    yield


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    seen: list[tuple[str, str]] = []
    original = loteria_service.publish_game_after_commit

    def record(db: Any, game_id: uuid.UUID, kind: str) -> None:
        seen.append((str(game_id), kind))
        original(db, game_id, kind)

    monkeypatch.setattr(loteria_service, "publish_game_after_commit", record)
    return seen


async def _create(host: Phone, *, seed: int = SEED, open_: bool = True, **config: Any) -> str:
    resp = await host.post(GAMES, {"kind": "loteria", "title": "Loteria", **config})
    assert resp.status_code == 201, resp.text
    gid = str(resp.json()["id"])
    if open_:
        opened = await _send(host, "POST", f"{GAMES}/{gid}/loteria/open", **{TEST_SEED: str(seed)})
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


async def _join(p: Phone, gid: str, person: uuid.UUID, seed: int = 7) -> list[int]:
    resp = await _send(
        p,
        "POST",
        f"{GAMES}/{gid}/loteria/join",
        {"person_id": str(person)},
        **{TEST_SEED: str(seed)},
    )
    assert resp.status_code == 200, resp.text
    squares: list[int] = resp.json()["squares"]
    return squares


async def _start(host: Phone, gid: str) -> Any:
    return await _send(host, "POST", f"{GAMES}/{gid}/loteria/start")


async def _draw(host: Phone, gid: str, seq: int) -> Any:
    return await _send(host, "POST", f"{GAMES}/{gid}/loteria/draw", {"expected_seq": seq})


async def _draw_until(host: Phone, gid: str, have: int, cards: set[int]) -> int:
    order = loteria.call_order(SEED)
    need = max(order.index(c) for c in cards) + 1
    for seq in range(have, need):
        assert (await _draw(host, gid, seq)).status_code == 200
    return max(need, have)


async def _check(host: Phone, gid: str, person: uuid.UUID) -> Any:
    return await _send(host, "POST", f"{GAMES}/{gid}/loteria/check", {"person_id": str(person)})


async def _mark(p: Phone, gid: str, person: uuid.UUID, index: int, method: str = "PUT") -> Any:
    return await _send(p, method, f"{GAMES}/{gid}/loteria/mark/{index}?person_id={person}")


async def _status(host: Phone, gid: str) -> str:
    return str((await host.client.get(f"{GAMES}/{gid}")).json()["status"])


async def test_54_draws_never_repeat_and_follow_the_pinned_seed(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _create(host)
        assert (await _draw(host, gid, 0)).status_code == 409  # open, not live
        assert (await _start(host, gid)).status_code == 200
        for seq in range(54):
            resp = await _draw(host, gid, seq)
            assert resp.status_code == 200, resp.text
        snap = resp.json()["loteria"]
        assert [c["card_id"] for c in snap["calls"]] == loteria.call_order(SEED)
        assert len({c["card_id"] for c in snap["calls"]}) == 54
        assert snap["last_call"]["seq"] == 53 and snap["last_call"]["name_es"]
        again = await _draw(host, gid, 54)
        assert again.status_code == 409 and "Every card" in again.json()["error"]["message"]
        assert "seed" not in str(resp.json())  # the seed never reaches a snapshot
        # The same pinned seed reproduces a whole second game.
        other = await _create(host)
        await _start(host, other)
        first = (await _draw(host, other, 0)).json()["loteria"]["calls"][0]["card_id"]
        assert first == loteria.call_order(SEED)[0]


async def test_a_stale_draw_inserts_nothing_and_guests_cannot_draw(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _create(host)
        await _start(host, gid)
        assert (await _draw(host, gid, 3)).status_code == 409
        assert await _rows(a, "SELECT 1 FROM bingo_calls WHERE game_id = :g", g=gid) == []
        async with _player(a, host) as (p, sam):
            await _join(p, gid, sam)
            assert (await _draw(p, gid, 0)).status_code in (401, 403)
            assert (await _check(p, gid, sam)).status_code in (401, 403)
        assert (await _draw(host, gid, 0)).status_code == 200
        assert (await _draw(host, gid, 0)).status_code == 409


async def test_marking_is_limited_to_called_cards(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _create(host)
        async with _player(a, host) as (p, sam):
            squares = await _join(p, gid, sam)
            assert len(squares) == 16 and len(set(squares)) == 16
            assert (await _mark(p, gid, sam, 0)).status_code == 409  # not started
            await _start(host, gid)
            order = loteria.call_order(SEED)
            until = order.index(squares[5]) + 1
            for seq in range(until):
                assert (await _draw(host, gid, seq)).status_code == 200
            uncalled = next(i for i, c in enumerate(squares) if c not in order[:until])
            blocked = await _mark(p, gid, sam, uncalled)
            assert blocked.status_code == 409
            assert blocked.json()["error"]["message"] == "That card hasn't been called."
            ok = await _mark(p, gid, sam, 5)
            assert ok.status_code == 200 and 5 in ok.json()["marked"]
            assert (await _mark(p, gid, sam, 5)).status_code == 200  # idempotent
            undone = await _mark(p, gid, sam, 5, "DELETE")
            assert 5 not in undone.json()["marked"]
            assert (await _mark(p, gid, sam, 16)).status_code == 422


async def test_a_false_check_changes_nothing_then_a_true_one_wins(
    two_households: Pair, events: list[tuple[str, str]]
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _create(host)
        async with _player(a, host) as (p, sam):
            squares = await _join(p, gid, sam)
            await _start(host, gid)
            await _draw(host, gid, 0)
            before = len(events)
            miss = await _check(host, gid, sam)
            body = miss.json()
            assert body["valid"] is False and body["squares"] is None and body["missing"] >= 1
            assert len(events) == before
            assert await _status(host, gid) == "live"
            assert (await _rows(a, "SELECT won_at FROM bingo_cards WHERE game_id = :g", g=gid))[
                0
            ].won_at is None
            # The player never taps; calling the whole top row still checks valid.
            await _draw_until(host, gid, 1, set(squares[:4]))
            ok = (await _check(host, gid, sam)).json()
            assert ok["valid"] is True and ok["missing"] == 0 and ok["squares"] is not None
            assert await _status(host, gid) == "ended"
            snap = (await host.client.get(f"{GAMES}/{gid}")).json()["loteria"]
            assert snap["players"][0]["won"] is True and snap["players"][0]["finish_place"] == 1
            assert (await _check(host, gid, sam)).status_code == 409
            audits = await _rows(
                a, "SELECT data FROM audit_events WHERE action = 'game.loteria_checked'"
            )
            assert [r.data["valid"] for r in audits] == [False, True]


async def test_four_corners_centre_four_and_full(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        cases = {
            "corners": [0, 3, 12, 15],
            "center": [5, 6, 9, 10],
            "full": list(range(16)),
        }
        async with _player(a, host) as (p, sam):
            for mode, need in cases.items():
                gid = await _create(host, pattern=mode)
                squares = await _join(p, gid, sam)
                await _start(host, gid)
                done = await _draw_until(host, gid, 0, {squares[i] for i in need[:-1]})
                # One card short is not a win (unless the shuffle already called the last one).
                last_called = squares[need[-1]] in loteria.call_order(SEED)[:done]
                if not last_called:
                    assert (await _check(host, gid, sam)).json()["valid"] is False
                await _draw_until(host, gid, done, {squares[i] for i in need})
                hit = (await _check(host, gid, sam)).json()
                assert hit["valid"] is True and hit["pattern"] == mode
                assert hit["squares"] == need


async def test_end_on_first_win_can_be_turned_off(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _create(host, end_on_first_win=False, pattern="center")
        async with _player(a, host) as (p, sam):
            squares = await _join(p, gid, sam)
            await _start(host, gid)
            await _draw_until(host, gid, 0, {squares[i] for i in (5, 6, 9, 10)})
            assert (await _check(host, gid, sam)).json()["valid"] is True
            assert await _status(host, gid) == "live"
            assert (await _check(host, gid, uuid.uuid4())).status_code == 404


async def test_reroll_is_unlimited_while_open_and_refused_once_live(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _create(host)
        async with _player(a, host) as (p, sam):
            first = await _join(p, gid, sam, seed=1)
            seen = [first]
            for seed in (2, 3, 4):
                resp = await _send(
                    p,
                    "POST",
                    f"{GAMES}/{gid}/loteria/reroll",
                    {"person_id": str(sam)},
                    **{TEST_SEED: str(seed)},
                )
                assert resp.status_code == 200, resp.text
                assert resp.json()["marked"] == []
                seen.append(resp.json()["squares"])
            assert all(seen[i] != seen[i + 1] for i in range(3))
            mine = (await p.client.get(f"{GAMES}/{gid}/loteria/mine")).json()
            assert mine[0]["squares"] == seen[-1]
            await _start(host, gid)
            refused = await _send(
                p, "POST", f"{GAMES}/{gid}/loteria/reroll", {"person_id": str(sam)}
            )
            assert refused.status_code == 409
            assert (await p.client.get(f"{GAMES}/{gid}/loteria/mine")).json()[0]["squares"] == (
                seen[-1]
            )


async def test_loteria_and_bingo_routes_do_not_mix_and_bad_pattern_is_422(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _create(host)
        assert (await _send(host, "POST", f"{GAMES}/{gid}/open")).status_code == 404
        bingo = await host.post(GAMES, {"kind": "bingo", "title": "B", "mode": "classic"})
        bid = str(bingo.json()["id"])
        assert (await _send(host, "POST", f"{GAMES}/{bid}/loteria/open")).status_code == 404
        bad = await host.post(GAMES, {"kind": "loteria", "title": "x", "pattern": "zz"})
        assert bad.status_code == 422
        game = (await host.client.get(f"{GAMES}/{gid}")).json()
        assert game["kind"] == "loteria" and game["loteria"]["pattern"] == "line"
        assert game["bingo"] is None


async def test_other_household_gets_404_everywhere(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as host_a, phone() as host_b:
        await _host(host_a, a)
        await _host(host_b, b)
        gid = await _create(host_a)
        await _start(host_a, gid)
        calls = [
            await _draw(host_b, gid, 0),
            await _check(host_b, gid, uuid.uuid4()),
            await _send(host_b, "POST", f"{GAMES}/{gid}/loteria/start"),
            await _send(host_b, "POST", f"{GAMES}/{gid}/loteria/open"),
            await host_b.client.get(f"{GAMES}/{gid}"),
        ]
        assert [r.status_code for r in calls] == [404] * 5
