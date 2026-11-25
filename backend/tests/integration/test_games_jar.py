"""Games: the Gratitude Jar end to end, plus game SSE tickets (ADR-0018, slice A)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from httpx import Response

from app.core.config import settings
from app.domain.games import jar
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


async def _jar(host: Phone, **extra: Any) -> str:
    resp = await host.post(GAMES, {"kind": "gratitude_jar", "title": "Thanksgiving", **extra})
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


@asynccontextmanager
async def _player(
    h: SeededHousehold, host: Phone, name: str = "Sam"
) -> AsyncIterator[tuple[Phone, uuid.UUID]]:
    """A phone joined to the household and acting as a fresh person."""
    _, code, _ = await _night(host, 2)
    person = await _person(h, name)
    async with phone() as p:
        await _phone_for(p, h, code, person)
        yield p, person


async def _drop(
    p: Phone, gid: str, person: uuid.UUID, body: str, anonymous: bool = False
) -> Response:
    return await _send(
        p,
        "POST",
        f"{GAMES}/{gid}/jar/notes",
        {"person_id": str(person), "body": body, "anonymous": anonymous},
    )


async def test_host_starts_a_jar_and_players_drop_notes(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _jar(host)
        async with _player(a, host) as (p, sam):
            resp = await _drop(p, gid, sam, "  Pie   and\n family ")
            assert resp.status_code == 201
            assert resp.json()["body"] == "Pie and family"
            mine = (await p.client.get(f"{GAMES}/{gid}/jar/notes/mine")).json()
            assert [n["body"] for n in mine] == ["Pie and family"]
            # The snapshot shows a count, never the note before it is revealed.
            snap = (await host.client.get(f"{GAMES}/{gid}")).json()
            assert snap["jar"]["note_count"] == 1
            assert snap["jar"]["revealed"] == [] and snap["jar"]["current"] is None
            assert "Pie" not in str(snap)


async def test_only_hosts_run_a_game_and_unknown_kinds_are_refused(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host, phone() as nobody:
        await _host(host, a)
        assert (await host.post(GAMES, {"kind": "chess", "title": "B"})).status_code == 422
        gid = await _jar(host)
        assert (
            await nobody.post(GAMES, {"kind": "gratitude_jar", "title": "x"})
        ).status_code == 401
        assert (await _send(nobody, "POST", f"{GAMES}/{gid}/jar/start-reveal")).status_code == 401
        assert (await nobody.client.get(f"{GAMES}/{gid}")).status_code == 401


async def test_a_phone_cannot_drop_a_note_as_someone_it_is_not(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _jar(host)
        async with _player(a, host) as (p, _sam):
            stranger = await _person(a, "Stranger")
            assert (await _drop(p, gid, stranger, "hi")).status_code == 403
            assert (await _drop(p, gid, _sam, "   ")).status_code == 422
            assert (await _drop(p, gid, _sam, "x" * 281)).status_code == 422


async def test_anonymous_notes_can_be_turned_off(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _jar(host, allow_anonymous=False)
        async with _player(a, host) as (p, sam):
            assert (await _drop(p, gid, sam, "hi", anonymous=True)).status_code == 422
            assert (await _drop(p, gid, sam, "hi")).status_code == 201


async def test_reveal_walks_a_seeded_order_and_hides_anonymous_authors(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _jar(host)
        async with _player(a, host) as (p, sam):
            for i in range(4):
                assert (
                    await _drop(p, gid, sam, f"note {i}", anonymous=i % 2 == 1)
                ).status_code == 201
            # An empty reveal and an early "next" are refused.
            assert (await _send(host, "POST", f"{GAMES}/{gid}/jar/reveal-next")).status_code == 409
            started = await host.client.post(
                f"{GAMES}/{gid}/jar/start-reveal",
                headers={"X-FNH-CSRF": await host.csrf(), "X-FNH-Test-Seed": "7"},
            )
            assert started.status_code == 200 and started.json()["status"] == "live"
            # No more notes once the reveal has started.
            assert (await _drop(p, gid, sam, "late")).status_code == 409
            assert (await _send(host, "POST", f"{GAMES}/{gid}/jar/start-reveal")).status_code == 409

            rows = await _rows(a, "SELECT id, body FROM gratitude_notes WHERE game_id = :g", g=gid)
            body = {str(r.id): r.body for r in rows}
            expected = [body[str(i)] for i in jar.reveal_order([uuid.UUID(k) for k in body], 7)]

            shown: list[dict[str, Any]] = []
            for _ in range(4):
                snap = (await _send(host, "POST", f"{GAMES}/{gid}/jar/reveal-next")).json()
                shown = snap["jar"]["revealed"]
            assert [n["body"] for n in shown] == expected
            for n in shown:
                anonymous = n["body"] in ("note 1", "note 3")
                assert (n["author"] is None) == anonymous
            assert snap["jar"]["remaining"] == 0
            assert (await _send(host, "POST", f"{GAMES}/{gid}/jar/reveal-next")).status_code == 409

            ended = await _send(host, "POST", f"{GAMES}/{gid}/end")
            assert ended.json()["status"] == "ended"
            assert (await _send(host, "POST", f"{GAMES}/{gid}/end")).status_code == 200


async def test_host_can_read_and_hide_notes_before_they_show(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _jar(host)
        async with _player(a, host) as (p, sam):
            keep = (await _drop(p, gid, sam, "keep me")).json()["id"]
            bad = (await _drop(p, gid, sam, "hide me", anonymous=True)).json()["id"]
            mod = (await host.client.get(f"{GAMES}/{gid}/jar/moderation")).json()
            by_id = {n["id"]: n for n in mod}
            assert by_id[bad]["body"] == "hide me"
            assert by_id[bad]["author"] is None  # anonymous, even to the host
            assert by_id[keep]["author"]["person_id"] == str(sam)

            hide = f"{GAMES}/{gid}/jar/notes/{bad}/hide"
            assert (await _send(host, "POST", hide)).status_code == 204
            assert (await _send(host, "POST", hide)).status_code == 204  # idempotent
            assert (
                await _send(host, "POST", f"{GAMES}/{gid}/jar/notes/{uuid.uuid4()}/hide")
            ).status_code == 404

            await _send(host, "POST", f"{GAMES}/{gid}/jar/start-reveal")
            snap = (await _send(host, "POST", f"{GAMES}/{gid}/jar/reveal-next")).json()
            assert [n["body"] for n in snap["jar"]["revealed"]] == ["keep me"]
            assert snap["jar"]["note_count"] == 1
            # Hosts only: a phone has no moderation list.
            assert (await p.client.get(f"{GAMES}/{gid}/jar/moderation")).status_code == 401


async def test_an_author_can_take_a_note_back_until_it_is_shown(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _jar(host)
        async with _player(a, host) as (p, sam), _player(a, host, "Kim") as (q, _kim):
            mine = (await _drop(p, gid, sam, "mine")).json()["id"]
            other = (await _drop(p, gid, sam, "second")).json()["id"]
            # Someone else's phone can't delete it (404, not 403: no probing).
            assert (await _send(q, "DELETE", f"{GAMES}/{gid}/jar/notes/{mine}")).status_code == 404
            assert (await _send(p, "DELETE", f"{GAMES}/{gid}/jar/notes/{mine}")).status_code == 204
            assert (await _send(p, "DELETE", f"{GAMES}/{gid}/jar/notes/{mine}")).status_code == 404
            await _send(host, "POST", f"{GAMES}/{gid}/jar/start-reveal")
            await _send(host, "POST", f"{GAMES}/{gid}/jar/reveal-next")
            assert (await _send(p, "DELETE", f"{GAMES}/{gid}/jar/notes/{other}")).status_code == 404


async def test_another_household_cannot_see_or_run_a_game(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as host_a, phone() as host_b:
        await _host(host_a, a)
        await _host(host_b, b)
        gid = await _jar(host_a)
        assert (await host_b.client.get(f"{GAMES}/{gid}")).status_code == 404
        assert (await host_b.client.get(f"{GAMES}/{gid}/jar/moderation")).status_code == 404
        assert (await _send(host_b, "POST", f"{GAMES}/{gid}/jar/start-reveal")).status_code == 404
        assert (await _send(host_b, "POST", f"{GAMES}/{gid}/end")).status_code == 404
        assert [g["title"] for g in (await host_b.client.get(GAMES)).json()] == ["Seed jar"]
        assert (
            await _send(host_b, "POST", "/api/v1/sse-tickets", {"game_id": gid})
        ).status_code == 404


async def test_game_tickets_open_only_the_game_stream(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _jar(host)
        sid, _, _ = await _night(host, 2)
        bad = await _send(host, "POST", "/api/v1/sse-tickets", {"game_id": gid, "session_id": sid})
        assert bad.status_code == 422
        assert (await _send(host, "POST", "/api/v1/sse-tickets", {})).status_code == 422

        game_ticket = (await _send(host, "POST", "/api/v1/sse-tickets", {"game_id": gid})).json()
        night_ticket = (
            await _send(host, "POST", "/api/v1/sse-tickets", {"session_id": sid})
        ).json()
        # A ticket for a game does not open a night's stream, nor the reverse.
        r = await host.client.get(f"/api/v1/sessions/{gid}/stream?ticket={game_ticket['ticket']}")
        assert r.status_code == 401
        r = await host.client.get(f"{GAMES}/{sid}/stream?ticket={night_ticket['ticket']}")
        assert r.status_code == 401
        # Burned once presented, even wrongly.
        r = await host.client.get(f"{GAMES}/{gid}/stream?ticket={game_ticket['ticket']}")
        assert r.status_code == 401


async def test_merging_moves_notes_and_removing_a_person_erases_them(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host, phone() as admin:
        await _host(host, a)
        admin.sign_in_as(a.ids["account"], a.household_id)
        gid = await _jar(host)
        async with _player(a, host, "Dupe") as (p, dupe):
            assert (await _drop(p, gid, dupe, "from the duplicate")).status_code == 201
            keep = await _person(a, "Keeper")
            merge = {"from_person_id": str(dupe), "into_person_id": str(keep)}
            assert (await admin.post("/api/v1/admin/people/merge", merge)).status_code == 200
            rows = await _rows(a, "SELECT person_id FROM gratitude_notes WHERE body LIKE 'from%'")
            assert [r.person_id for r in rows] == [keep]

            resp = await admin.client.delete(
                f"/api/v1/admin/people/{keep}", headers={"X-FNH-CSRF": await admin.csrf()}
            )
            assert resp.status_code == 200, resp.text
            assert await _rows(a, "SELECT 1 FROM gratitude_notes WHERE body LIKE 'from%'") == []


async def test_the_export_includes_games_and_notes(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as admin:
        admin.sign_in_as(a.ids["account"], a.household_id)
        resp = await admin.client.get("/api/v1/admin/export")
        assert resp.status_code == 200
        import io
        import zipfile

        names = zipfile.ZipFile(io.BytesIO(resp.content)).namelist()
        for table in ("games", "game_players", "gratitude_notes"):
            assert f"tables/{table}.json" in names
