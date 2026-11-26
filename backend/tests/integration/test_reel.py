"""The night reel: GET /reel derives typed slides from existing tables (ADR-0018 amendment)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.core.database import household_session
from tests.integration.phones import Phone, phone
from tests.integration.seed import SeededHousehold
from tests.integration.storage_doubles import FakeStorage, storage
from tests.integration.test_voting import _host, _person

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
REEL = "/api/v1/reel"


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    yield


@pytest.fixture
def fake() -> Iterator[FakeStorage]:
    bucket = FakeStorage()
    with storage(bucket):
        yield bucket


@asynccontextmanager
async def _host_phone(h: SeededHousehold) -> AsyncIterator[tuple[Phone, uuid.UUID]]:
    async with phone() as p:
        account = await _host(p, h)
        yield p, account


async def _sql(h: SeededHousehold, sql: str, **params: Any) -> Any:
    async with household_session(h.household_id) as db:
        result = await db.execute(text(sql), {"h": h.household_id, **params})
        return result.first() if result.returns_rows else None


async def _game(
    h: SeededHousehold,
    account: uuid.UUID,
    kind: str,
    title: str,
    status: str = "live",
    config: str = "{}",
) -> uuid.UUID:
    row = await _sql(
        h,
        "INSERT INTO games (household_id, kind, title, status, config, created_by_account_id) "
        "VALUES (:h, :k, :t, :s, CAST(:c AS jsonb), :a) RETURNING id",
        k=kind,
        t=title,
        s=status,
        c=config,
        a=account,
    )
    return uuid.UUID(str(row.id))


async def _note(
    h: SeededHousehold,
    game: uuid.UUID,
    person: uuid.UUID,
    body: str,
    *,
    anonymous: bool = False,
    revealed_ago: str | None = "1 hour",
    hidden: bool = False,
    pos: int | None = None,
) -> uuid.UUID:
    row = await _sql(
        h,
        "INSERT INTO gratitude_notes (household_id, game_id, person_id, body, anonymous, "
        "reveal_position, revealed_at, hidden_at) VALUES (:h, :g, :p, :b, :an, :pos, "
        "CASE WHEN CAST(:ago AS text) IS NULL THEN NULL "
        "ELSE now() - CAST(:ago AS interval) END, "
        "CASE WHEN :hid THEN now() END) RETURNING id",
        g=game,
        p=person,
        b=body,
        an=anonymous,
        pos=pos,
        ago=revealed_ago,
        hid=hidden,
    )
    return uuid.UUID(str(row.id))


async def _reel(p: Phone, window: str = "tonight", seed: int | None = None) -> dict[str, Any]:
    headers = {"X-FNH-Test-Seed": str(seed)} if seed is not None else {}
    resp = await p.client.get(REEL, params={"window": window}, headers=headers)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _ids(reel: dict[str, Any], kind: str | None = None) -> list[str]:
    return [i["id"] for i in reel["items"] if kind is None or i["kind"] == kind]


async def test_quotes_include_ended_jars_and_never_leak_hidden_or_anonymous(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with _host_phone(a) as (p, account):
        sam = await _person(a, "Sam")
        secret = await _person(a, "Secretive")
        ended = await _game(a, account, "gratitude_jar", "Last year", status="ended")
        shown = await _note(a, ended, sam, "Pie and family", pos=0)
        anon = await _note(a, ended, secret, "A quiet thanks", anonymous=True, pos=1)
        hidden = await _note(a, ended, sam, "Not for the TV", hidden=True, pos=2)
        unrevealed = await _note(a, ended, sam, "Still in the jar", revealed_ago=None)

        reel = await _reel(p)
        quotes = {i["id"]: i for i in reel["items"] if i["kind"] == "quote"}
        assert set(quotes) == {f"quote:{shown}", f"quote:{anon}"}
        assert quotes[f"quote:{shown}"]["author"]["name"] == "Sam"
        assert quotes[f"quote:{shown}"]["game_title"] == "Last year"
        assert quotes[f"quote:{anon}"]["author"] is None
        blob = str(reel)
        for forbidden in (
            "Secretive",
            "Not for the TV",
            "Still in the jar",
            str(hidden),
            str(unrevealed),
        ):
            assert forbidden not in blob
        assert "pin" not in blob.lower()


async def test_bingo_winners_carry_their_place_and_mode(two_households: Pair) -> None:
    a, _ = two_households
    async with _host_phone(a) as (p, account):
        classic = await _game(
            a, account, "bingo", "Friday", status="ended", config='{"mode": "classic"}'
        )
        thanks = await _game(a, account, "bingo", "Turkey", config='{"mode": "thanksgiving"}')
        first, second, third = [await _person(a, n) for n in ("Ana", "Ben", "Cy")]
        squares = "ARRAY[" + ",".join(f"'s{i}'" for i in range(25)) + "]"
        for game, person, ago in [
            (classic, first, "30 minutes"),
            (classic, second, "20 minutes"),
            (thanks, third, "10 minutes"),
        ]:
            await _sql(
                a,
                f"INSERT INTO bingo_cards (household_id, game_id, person_id, squares, won_at) "
                f"VALUES (:h, :g, :p, {squares}, now() - CAST(CAST(:ago AS text) AS interval))",
                g=game,
                p=person,
                ago=ago,
            )
        # A card that has not won yet is not a winner.
        loser = await _person(a, "Dee")
        await _sql(
            a,
            f"INSERT INTO bingo_cards (household_id, game_id, person_id, squares) "
            f"VALUES (:h, :g, :p, {squares})",
            g=classic,
            p=loser,
        )

        reel = await _reel(p)
        winners = {i["id"]: i for i in reel["items"] if i["kind"] == "winner"}
        assert len(winners) == 3
        w1 = winners[f"winner:bingo:{classic}:{first}"]
        assert (w1["place"], w1["label"], w1["winners"][0]["name"]) == (1, "Classic bingo", "Ana")
        assert winners[f"winner:bingo:{classic}:{second}"]["place"] == 2
        w3 = winners[f"winner:bingo:{thanks}:{third}"]
        assert (w3["place"], w3["label"]) == (1, "Thanksgiving bingo")
        assert "Dee" not in str(reel)


async def test_scattergories_round_winner_and_leaderboard(two_households: Pair) -> None:
    a, _ = two_households
    async with _host_phone(a) as (p, account):
        game = await _game(a, account, "scattergories", "Letters", status="ended")
        sam, alex = await _person(a, "Sam"), await _person(a, "Alex")
        for person in (sam, alex):
            await _sql(
                a,
                "INSERT INTO game_players (household_id, game_id, person_id) VALUES (:h, :g, :p)",
                g=game,
                p=person,
            )
        rnd = await _sql(
            a,
            "INSERT INTO scatter_rounds (household_id, game_id, round_no, letter, categories, "
            "duration_seconds, ends_at, revealed_at) VALUES (:h, :g, 1, 'M', "
            'CAST(\'["animal", "food", "place"]\' AS jsonb), 60, now() - interval \'5 minutes\', '
            "now() - interval '4 minutes') RETURNING id",
            g=game,
        )
        for person, idx, word in [
            (sam, 0, "Moose"),
            (sam, 1, "Mango"),
            (sam, 2, "Madrid"),
            (alex, 0, "Mouse"),
        ]:
            await _sql(
                a,
                "INSERT INTO scatter_answers (household_id, round_id, person_id, category_index, "
                "text) VALUES (:h, :r, :p, :i, :t)",
                r=rnd.id,
                p=person,
                i=idx,
                t=word,
            )

        reel = await _reel(p)
        win = next(i for i in reel["items"] if i["kind"] == "winner")
        assert win["id"] == f"winner:scatter:{game}:1"
        assert [w["name"] for w in win["winners"]] == ["Sam"]
        assert win["points"] and win["label"] == "Round 1, letter M"
        board = next(i for i in reel["items"] if i["kind"] == "leaderboard")
        assert board["final"] is True
        assert board["standings"][0]["person"]["name"] == "Sam"
        assert board["standings"][0]["points"] >= board["standings"][1]["points"]


async def test_photos_only_when_ready_and_with_fresh_urls(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    async with _host_phone(a) as (p, account):
        del account
        sam = await _person(a, "Sam")
        sid = a.ids["session"]
        ids: dict[str, uuid.UUID] = {}
        for status in ("ready", "hidden", "pending"):
            row = await _sql(
                a,
                "INSERT INTO photos (household_id, session_id, person_id, object_key, thumb_key, "
                "status) VALUES (:h, :s, :p, :o, :t, :st) RETURNING id",
                s=sid,
                p=sam,
                o=f"k/{status}.jpg",
                t=f"k/{status}_t.jpg",
                st=status,
            )
            ids[status] = uuid.UUID(str(row.id))

        reel = await _reel(p)
        photos = [i for i in reel["items"] if i["kind"] == "photo"]
        assert [i["id"] for i in photos] == [f"photo:{ids['ready']}"]
        assert "k/ready.jpg" in photos[0]["photo_url"] and "op=get" in photos[0]["photo_url"]
        assert photos[0]["photo_by"]["name"] == "Sam"
        assert "hidden.jpg" not in str(reel) and "pending.jpg" not in str(reel)


async def test_no_storage_means_no_photos_not_an_error(two_households: Pair) -> None:
    a, _ = two_households
    async with _host_phone(a) as (p, _account):
        sam = await _person(a, "Sam")
        await _sql(
            a,
            "INSERT INTO photos (household_id, session_id, person_id, object_key, thumb_key, "
            "status) VALUES (:h, :s, :p, 'k/x.jpg', 'k/x_t.jpg', 'ready')",
            s=a.ids["session"],
            p=sam,
        )
        with storage(None):
            assert _ids(await _reel(p), "photo") == []


async def test_window_tonight_drops_old_slides_and_all_keeps_them(two_households: Pair) -> None:
    a, _ = two_households
    async with _host_phone(a) as (p, account):
        sam = await _person(a, "Sam")
        game = await _game(a, account, "gratitude_jar", "Jar", status="ended")
        recent = await _note(a, game, sam, "Tonight", revealed_ago="2 hours", pos=0)
        old = await _note(a, game, sam, "Last year", revealed_ago="400 days", pos=1)

        tonight = await _reel(p, "tonight")
        assert _ids(tonight, "quote") == [f"quote:{recent}"]
        assert tonight["since"] is not None
        everything = await _reel(p, "all")
        assert set(_ids(everything, "quote")) == {f"quote:{recent}", f"quote:{old}"}
        assert everything["since"] is None
        assert (await p.client.get(REEL, params={"window": "week"})).status_code == 422


async def test_other_households_and_strangers_see_nothing_of_it(two_households: Pair) -> None:
    a, b = two_households
    async with _host_phone(a) as (pa, account):
        sam = await _person(a, "Sam")
        game = await _game(a, account, "gratitude_jar", "Jar")
        await _note(a, game, sam, "Ours alone")
        assert len(_ids(await _reel(pa), "quote")) == 1
    async with _host_phone(b) as (pb, _acct):
        reel = await _reel(pb, "all")
        assert reel["items"] == []
        assert "Ours alone" not in str(reel)
    async with phone() as nobody:
        assert (await nobody.client.get(REEL)).status_code == 401


async def test_the_order_is_seeded_stable_and_survives_a_new_slide(two_households: Pair) -> None:
    a, _ = two_households
    async with _host_phone(a) as (p, account):
        sam = await _person(a, "Sam")
        game = await _game(a, account, "gratitude_jar", "Jar", status="ended")
        for n in range(12):
            await _note(a, game, sam, f"Note {n}", pos=n)

        first = _ids(await _reel(p, seed=7))
        assert first == _ids(await _reel(p, seed=7))
        others = [_ids(await _reel(p, seed=s)) for s in (8, 9, 10)]
        assert any(o != first for o in others)

        extra = await _note(a, game, sam, "A latecomer", pos=12)
        after = _ids(await _reel(p, seed=7))
        assert f"quote:{extra}" in after
        assert [i for i in after if i != f"quote:{extra}"] == first

        reel = await _reel(p, seed=7)
        assert reel["dwell_seconds"] == 12 and reel["anchor"] and reel["server_now"]
        # Without a pinned seed the order still holds from one read to the next.
        assert _ids(await _reel(p)) == _ids(await _reel(p))
