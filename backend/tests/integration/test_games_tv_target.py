"""The paired TV's target: which game a host sent to the TV (ADR-0018 amendment)."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from app.core.config import settings
from tests.integration.phones import Phone, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_voting import _host, _night, _person, _phone_for, _send

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
GAMES = "/api/v1/games"
TARGET = f"{GAMES}/tv-target"


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    yield


async def _jar(host: Phone) -> str:
    resp = await host.post(GAMES, {"kind": "gratitude_jar", "title": "Thanksgiving"})
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def _put(p: Phone, game_id: str | None) -> int:
    return (await _send(p, "PUT", TARGET, {"game_id": game_id})).status_code


async def test_a_host_sends_a_game_to_the_tv_and_any_device_reads_it(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host, phone() as tv:
        await _host(host, a)
        gid = await _jar(host)
        assert await _put(host, None) == 200  # the seed points at its own game
        assert (await host.client.get(TARGET)).json()["game_id"] is None

        resp = await _send(host, "PUT", TARGET, {"game_id": gid})
        assert resp.status_code == 200 and resp.json()["game_id"] == gid

        # A paired device (a phone bound to the household) reads it; hosts read it too.
        _, code, _ = await _night(host, 2)
        await _phone_for(tv, a, code, await _person(a, "Sam"))
        assert (await tv.client.get(TARGET)).json()["game_id"] == gid
        assert (await host.client.get(TARGET)).json()["game_id"] == gid

        # Back to the QR: idempotent.
        assert await _put(host, None) == 200
        assert await _put(host, None) == 200
        assert (await tv.client.get(TARGET)).json()["game_id"] is None


async def test_the_target_is_replaced_and_falls_away_when_the_game_ends(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        first, second = await _jar(host), await _jar(host)
        assert await _put(host, first) == 200
        assert await _put(host, second) == 200
        assert (await host.client.get(TARGET)).json()["game_id"] == second

        assert (await host.post(f"{GAMES}/{second}/end")).status_code == 200
        ended = (await host.client.get(TARGET)).json()
        assert ended["game_id"] is None
        # The TV can still see which sent game ended, to hold its result screen a while.
        assert ended["ended_game_id"] == second and ended["ended_at"] and ended["server_now"]
        # Back to QR forgets it.
        assert await _put(host, None) == 200
        assert (await host.client.get(TARGET)).json()["ended_game_id"] is None
        # An ended game can't be sent again.
        assert await _put(host, second) == 409


async def test_only_hosts_set_the_target_and_other_households_games_are_404(
    two_households: Pair,
) -> None:
    a, b = two_households
    async with phone() as host_a, phone() as host_b, phone() as nobody:
        await _host(host_a, a)
        await _host(host_b, b)
        gid_a = await _jar(host_a)
        gid_b = await _jar(host_b)

        assert await _put(nobody, gid_a) == 401
        assert (await nobody.client.get(TARGET)).status_code == 401
        assert await _put(host_a, gid_b) == 404
        assert await _put(host_a, "00000000-0000-4000-8000-000000000000") == 404

        assert await _put(host_a, gid_a) == 200
        # The other household never sees it.
        assert (await host_b.client.get(TARGET)).json()["game_id"] != gid_a
