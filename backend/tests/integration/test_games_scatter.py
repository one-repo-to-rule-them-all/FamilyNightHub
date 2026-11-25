"""Games: Thanksgiving Scattergories end to end (ADR-0018, slice C)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import text

from app.core.config import settings
from app.core.database import household_session
from tests.integration.phones import Phone, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_voting import _host, _night, _person, _phone_for, _rows, _send

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
GAMES = "/api/v1/games"
CATS = ["Pie flavors", "Side dishes", "Desserts"]


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    yield


async def _game(host: Phone) -> str:
    resp = await host.post(GAMES, {"kind": "scattergories", "title": "Scatter"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["jar"] is None
    return str(resp.json()["id"])


async def _round(host: Phone, gid: str, seed: int = 1, **extra: Any) -> dict[str, Any]:
    body = {"categories": CATS, "duration_seconds": 60, **extra}
    resp = await _send(
        host, "POST", f"{GAMES}/{gid}/scatter/rounds", body, **{"X-FNH-Test-Seed": str(seed)}
    )
    assert resp.status_code == 201, resp.text
    return dict(resp.json())


@asynccontextmanager
async def _player(
    h: SeededHousehold, host: Phone, name: str
) -> AsyncIterator[tuple[Phone, uuid.UUID]]:
    _, code, _ = await _night(host, 2)
    person = await _person(h, name)
    async with phone() as p:
        await _phone_for(p, h, code, person)
        yield p, person


async def _join(p: Phone, gid: str, person: uuid.UUID) -> Response:
    return await _send(p, "POST", f"{GAMES}/{gid}/scatter/join", {"person_id": str(person)})


async def _answer(p: Phone, gid: str, person: uuid.UUID, *texts: str) -> Response:
    body = {
        "person_id": str(person),
        "answers": [{"category_index": i, "text": t} for i, t in enumerate(texts)],
    }
    return await _send(p, "PUT", f"{GAMES}/{gid}/scatter/answers", body)


async def _expire(h: SeededHousehold, gid: str, seconds_ago: int) -> None:
    async with household_session(h.household_id) as db:
        await db.execute(
            text(
                "UPDATE scatter_rounds SET ends_at = now() - make_interval(secs => :s) "
                "WHERE game_id = :g"
            ),
            {"s": seconds_ago, "g": gid},
        )


async def _snap(p: Phone, gid: str) -> dict[str, Any]:
    resp = await p.client.get(f"{GAMES}/{gid}")
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


async def _reveal(host: Phone, gid: str) -> dict[str, Any]:
    resp = await _send(host, "POST", f"{GAMES}/{gid}/scatter/reveal")
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


async def test_a_round_runs_on_the_servers_clock(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _game(host)
        assert (await _snap(host, gid))["scatter"]["current"] is None
        snap = await _round(host, gid, seed=7)
        cur = snap["scatter"]["current"]
        assert cur["round_no"] == 1 and cur["categories"] == CATS and cur["state"] == "running"
        assert len(cur["letter"]) == 1 and cur["letter"] not in "QUVXYZ"
        assert snap["status"] == "live" and snap["scatter"]["server_now"] < cur["ends_at"]
        # The next round cannot start until this one is revealed.
        again = await _send(host, "POST", f"{GAMES}/{gid}/scatter/rounds", {})
        assert again.status_code == 409
        await _expire(a, gid, 5)
        assert (await _snap(host, gid))["scatter"]["current"]["state"] == "closed"


async def test_the_host_can_draw_categories_and_start_with_the_draw(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _game(host)
        drawn = (await host.client.get(f"{GAMES}/{gid}/scatter/draw?count=5")).json()
        assert len(set(drawn["categories"])) == 5
        resp = await _send(host, "POST", f"{GAMES}/{gid}/scatter/rounds", {"count": 4})
        assert len(resp.json()["scatter"]["current"]["categories"]) == 4
        bad = [
            {"categories": ["", "  "]},
            {"categories": ["x" * 61]},
            {"categories": [f"c{i}" for i in range(13)]},
        ]
        await _reveal(host, gid)
        for body in bad:
            r = await _send(host, "POST", f"{GAMES}/{gid}/scatter/rounds", body)
            assert r.status_code == 422, body
        # A duplicate (case-insensitive) collapses rather than erroring.
        ok = await _send(
            host, "POST", f"{GAMES}/{gid}/scatter/rounds", {"categories": ["Pie", " pie ", "Ham"]}
        )
        assert ok.json()["scatter"]["current"]["categories"] == ["Pie", "Ham"]
        assert (
            await _send(host, "POST", f"{GAMES}/{gid}/scatter/rounds", {"duration_seconds": 5})
        ).status_code == 422


async def test_answers_are_hidden_from_everyone_until_reveal(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _game(host)
        async with _player(a, host, "Sam") as (p, sam):
            assert (await _join(p, gid, sam)).status_code == 204
            assert (await _join(p, gid, sam)).status_code == 204  # idempotent
            await _round(host, gid)
            resp = await _answer(p, gid, sam, "Pumpkin", "Potatoes")
            assert resp.status_code == 200
            assert [r["text"] for r in resp.json()] == ["Pumpkin", "Potatoes"]
            snap = await _snap(host, gid)
            assert "Pumpkin" not in str(snap) and snap["scatter"]["revealed"] == []
            assert snap["scatter"]["players"][0]["answered"] == 2
            # Own answers come back to their author's phone, and only theirs.
            mine = (await p.client.get(f"{GAMES}/{gid}/scatter/answers/mine")).json()
            assert [m["text"] for m in mine] == ["Pumpkin", "Potatoes"]
            assert "Pumpkin" not in str(await _snap(p, gid))
            # Replace one and clear another.
            await _answer(p, gid, sam, "Pecan", "")
            mine = (await p.client.get(f"{GAMES}/{gid}/scatter/answers/mine")).json()
            assert [m["text"] for m in mine] == ["Pecan"]

            shown = await _reveal(host, gid)
            texts = [x["text"] for x in shown["scatter"]["revealed"][0]["answers"]]
            assert texts == ["Pecan"]


async def test_a_late_answer_is_409_but_the_grace_window_is_honoured(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _game(host)
        async with _player(a, host, "Sam") as (p, sam):
            await _join(p, gid, sam)
            await _round(host, gid)
            await _expire(a, gid, 1)  # within the 2 s grace
            assert (await _answer(p, gid, sam, "Pie")).status_code == 200
            await _expire(a, gid, 10)
            late = await _answer(p, gid, sam, "Pecan")
            assert late.status_code == 409
            mine = (await p.client.get(f"{GAMES}/{gid}/scatter/answers/mine")).json()
            assert [m["text"] for m in mine] == ["Pie"]


async def test_submit_checks_who_where_and_what(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _game(host)
        async with _player(a, host, "Sam") as (p, sam):
            assert (await _answer(p, gid, sam, "Pie")).status_code == 409  # no round yet
            await _round(host, gid)
            assert (await _answer(p, gid, sam, "Pie")).status_code == 409  # not joined
            stranger = await _person(a, "Stranger")
            assert (await _join(p, gid, stranger)).status_code == 403
            await _join(p, gid, sam)
            assert (await _answer(p, gid, stranger, "Pie")).status_code == 403
            assert (await _answer(p, gid, sam, "x" * 61)).status_code == 422
            out_of_range = {"person_id": str(sam), "answers": [{"category_index": 3, "text": "x"}]}
            r = await _send(p, "PUT", f"{GAMES}/{gid}/scatter/answers", out_of_range)
            assert r.status_code == 422
            dupe = {
                "person_id": str(sam),
                "answers": [{"category_index": 0, "text": "a"}, {"category_index": 0, "text": "b"}],
            }
            assert (
                await _send(p, "PUT", f"{GAMES}/{gid}/scatter/answers", dupe)
            ).status_code == 422
            await _reveal(host, gid)
            assert (await _answer(p, gid, sam, "Pie")).status_code == 409  # frozen


async def test_scores_derive_from_uniqueness_and_the_host_can_override(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _game(host)
        async with _player(a, host, "Sam") as (p1, sam), _player(a, host, "Max") as (p2, max_):
            await _join(p1, gid, sam)
            await _join(p2, gid, max_)
            snap = await _round(host, gid, seed=3, categories=["One", "Two", "Three"])
            letter = snap["scatter"]["current"]["letter"]
            same = f"{letter}ame"
            # cat0: both give the same word (0 each). cat1: unique (1 each). cat2: wrong letter.
            await _answer(p1, gid, sam, f"The {same}", f"{letter}one", "1 wrong")
            await _answer(p2, gid, max_, same.upper(), f"{letter}two", "")
            shown = await _reveal(host, gid)
            by_person = {
                s["person_id"]: s["points"] for s in shown["scatter"]["revealed"][0]["scores"]
            }
            assert by_person == {str(sam): 1, str(max_): 1}
            board = {t["person_id"]: t["points"] for t in shown["scatter"]["leaderboard"]}
            assert board == by_person

            answers = shown["scatter"]["revealed"][0]["answers"]
            sam_dupe = next(
                x for x in answers if x["person_id"] == str(sam) and x["category_index"] == 0
            )
            assert sam_dupe["valid"] and sam_dupe["point"] == 0
            wrong = next(x for x in answers if x["category_index"] == 2)
            assert not wrong["valid"]
            # Rejecting Max's duplicate frees Sam's, so Sam scores 2 and Max stays on 1.
            max_dupe = next(
                x for x in answers if x["person_id"] == str(max_) and x["category_index"] == 0
            )
            path = f"{GAMES}/{gid}/scatter/answers/{max_dupe['answer_id']}/verdict"
            out = await _send(host, "PUT", path, {"verdict": "rejected"})
            assert out.status_code == 200, out.text
            board = {t["person_id"]: t["points"] for t in out.json()["scatter"]["leaderboard"]}
            assert board == {str(sam): 2, str(max_): 1}
            # Re-accepting restores the original scores.
            back = await _send(host, "PUT", path, {"verdict": "accepted"})
            board = {t["person_id"]: t["points"] for t in back.json()["scatter"]["leaderboard"]}
            assert board == {str(sam): 1, str(max_): 1}
            assert (await _send(host, "PUT", path, {"verdict": None})).status_code == 200
            # A player cannot judge.
            assert (await _send(p1, "PUT", path, {"verdict": "rejected"})).status_code in (401, 403)


async def test_a_verdict_needs_a_revealed_round_and_a_real_answer(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _game(host)
        async with _player(a, host, "Sam") as (p, sam):
            await _join(p, gid, sam)
            await _round(host, gid)
            await _answer(p, gid, sam, "Pie")
            rows = await _rows(a, "SELECT id FROM scatter_answers WHERE person_id = :p", p=sam)
            path = f"{GAMES}/{gid}/scatter/answers/{rows[0].id}/verdict"
            assert (await _send(host, "PUT", path, {"verdict": "rejected"})).status_code == 409
            missing = f"{GAMES}/{gid}/scatter/answers/{uuid.uuid4()}/verdict"
            assert (await _send(host, "PUT", missing, {"verdict": "rejected"})).status_code == 404


async def test_a_game_runs_several_rounds_and_sums_the_leaderboard(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _game(host)
        async with _player(a, host, "Sam") as (p, sam):
            await _join(p, gid, sam)
            total = 0
            for n in (1, 2):
                snap = await _round(host, gid, seed=n, categories=["One"])
                assert snap["scatter"]["current"]["round_no"] == n
                letter = snap["scatter"]["current"]["letter"]
                await _answer(p, gid, sam, f"{letter}lone")
                shown = await _reveal(host, gid)
                total += 1
            assert shown["scatter"]["leaderboard"][0]["points"] == total == 2
            assert [r["round_no"] for r in shown["scatter"]["revealed"]] == [1, 2]
            ended = await _send(host, "POST", f"{GAMES}/{gid}/end")
            assert ended.json()["status"] == "ended"
            assert (
                await _send(host, "POST", f"{GAMES}/{gid}/scatter/rounds", {})
            ).status_code == 409
            assert (await _join(p, gid, sam)).status_code == 409


async def test_revealing_early_ends_the_round(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        gid = await _game(host)
        assert (await _send(host, "POST", f"{GAMES}/{gid}/scatter/reveal")).status_code == 409
        await _round(host, gid)
        snap = await _reveal(host, gid)
        assert snap["scatter"]["current"]["state"] == "revealed"
        assert (await _send(host, "POST", f"{GAMES}/{gid}/scatter/reveal")).status_code == 409


async def test_only_hosts_run_a_round_and_other_kinds_do_not_answer(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host, phone() as nobody:
        await _host(host, a)
        gid = await _game(host)
        for method, path in (
            ("POST", f"{GAMES}/{gid}/scatter/rounds"),
            ("POST", f"{GAMES}/{gid}/scatter/reveal"),
        ):
            assert (await _send(nobody, method, path, {})).status_code == 401
        jar = (await host.post(GAMES, {"kind": "gratitude_jar", "title": "J"})).json()["id"]
        assert (await _send(host, "POST", f"{GAMES}/{jar}/scatter/rounds", {})).status_code == 404


async def test_another_household_cannot_see_or_run_a_scattergories_game(
    two_households: Pair,
) -> None:
    a, b = two_households
    async with phone() as host_a, phone() as host_b:
        await _host(host_a, a)
        await _host(host_b, b)
        gid = await _game(host_a)
        await _round(host_a, gid)
        for method, path in (
            ("GET", f"{GAMES}/{gid}"),
            ("GET", f"{GAMES}/{gid}/scatter/draw"),
            ("POST", f"{GAMES}/{gid}/scatter/rounds"),
            ("POST", f"{GAMES}/{gid}/scatter/reveal"),
            ("PUT", f"{GAMES}/{gid}/scatter/answers/{uuid.uuid4()}/verdict"),
        ):
            r = await _send(
                host_b, method, path, {"verdict": "rejected"} if method == "PUT" else {}
            )
            assert r.status_code == 404, (method, path)
        async with _player(b, host_b, "Outsider") as (p, outsider):
            assert (await _join(p, gid, outsider)).status_code == 404
            assert (await _answer(p, gid, outsider, "Pie")).status_code == 404
            assert (await p.client.get(f"{GAMES}/{gid}/scatter/answers/mine")).status_code == 404


async def test_merging_keeps_the_targets_answer_and_removing_a_person_erases_theirs(
    two_households: Pair,
) -> None:
    a, _ = two_households
    async with phone() as host, phone() as admin:
        await _host(host, a)
        admin.sign_in_as(a.ids["account"], a.household_id)
        gid = await _game(host)
        async with (
            _player(a, host, "Dupe") as (p1, dupe),
            _player(a, host, "Keeper") as (p2, keep),
        ):
            await _join(p1, gid, dupe)
            await _join(p2, gid, keep)
            await _round(host, gid, categories=["One", "Two"])
            await _answer(p1, gid, dupe, "From dupe", "Only dupe")
            await _answer(p2, gid, keep, "From keeper")
            merge = {"from_person_id": str(dupe), "into_person_id": str(keep)}
            assert (await admin.post("/api/v1/admin/people/merge", merge)).status_code == 200
            rows = await _rows(
                a,
                "SELECT category_index, text, person_id FROM scatter_answers "
                "WHERE text <> 'Pumpkin' ORDER BY 1",
            )
            assert [(r.text, r.person_id) for r in rows] == [
                ("From keeper", keep),
                ("Only dupe", keep),
            ]
            resp = await admin.client.delete(
                f"/api/v1/admin/people/{keep}", headers={"X-FNH-CSRF": await admin.csrf()}
            )
            assert resp.status_code == 200, resp.text
            assert (
                await _rows(a, "SELECT 1 FROM scatter_answers WHERE person_id = :p", p=keep) == []
            )


async def test_the_export_includes_scattergories_tables(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as admin:
        admin.sign_in_as(a.ids["account"], a.household_id)
        resp = await admin.client.get("/api/v1/admin/export")
        assert resp.status_code == 200
        import io
        import zipfile

        names = zipfile.ZipFile(io.BytesIO(resp.content)).namelist()
        for table in ("scatter_rounds", "scatter_answers"):
            assert f"tables/{table}.json" in names
