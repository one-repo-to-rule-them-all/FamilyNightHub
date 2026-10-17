"""Table-level cross-household isolation (ADR-0003; 07-cicd.md "isolation").

Two seeded households, a row in every household-scoped table each. Endpoint-level
isolation tests join this file as endpoints land.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.database import AsyncSessionLocal, household_session
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

SCOPED_TABLES = (
    "accounts",
    "magic_links",
    "people",
    "devices",
    "device_people",
    "movies",
    "sessions",
    "options",
    "ballot_ranks",
    "ratings",
    "photos",
    "photo_reactions",
    "photo_deletions",
    "settings",
    "audit_events",
    "pin_reset_requests",
)
Pair = tuple[SeededHousehold, SeededHousehold]


def _key(table: str) -> str:
    return "id" if table == "households" else "household_id"


@pytest.mark.parametrize("table", ["households", *SCOPED_TABLES])
async def test_household_sees_only_its_own_rows(two_households: Pair, table: str) -> None:
    a, b = two_households
    async with household_session(a.household_id) as s:
        own = await s.scalar(
            text(f"SELECT count(*) FROM {table} WHERE {_key(table)} = :h"), {"h": a.household_id}
        )
        other = await s.scalar(
            text(f"SELECT count(*) FROM {table} WHERE {_key(table)} = :h"), {"h": b.household_id}
        )
        foreign_total = await s.scalar(
            text(f"SELECT count(*) FROM {table} WHERE {_key(table)} <> :h"),
            {"h": a.household_id},
        )
    assert own >= 1
    assert other == 0
    assert foreign_total == 0


@pytest.mark.parametrize("table", ["households", *SCOPED_TABLES])
async def test_no_guc_sees_nothing(two_households: Pair, table: str) -> None:
    async with AsyncSessionLocal() as s, s.begin():
        assert await s.scalar(text(f"SELECT count(*) FROM {table}")) == 0


async def test_reset_guc_fails_closed_without_error(two_households: Pair) -> None:
    """After a transaction-local GUC ends, current_setting returns '' (not NULL) on that
    connection. app_household_id() must treat it as unset rather than raise on ''::uuid."""
    a, _ = two_households
    async with AsyncSessionLocal() as s:
        async with s.begin():
            await s.execute(
                text("SELECT set_config('app.household_id', :h, true)"), {"h": str(a.household_id)}
            )
        async with s.begin():
            assert await s.scalar(text("SELECT count(*) FROM people")) == 0


async def test_cannot_write_rows_into_another_household(two_households: Pair) -> None:
    a, b = two_households
    with pytest.raises(DBAPIError, match="row-level security"):
        async with household_session(a.household_id) as s:
            await s.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color) "
                    "VALUES (:h, 'Intruder', 'x', '#000')"
                ),
                {"h": b.household_id},
            )


async def test_cannot_update_or_delete_another_households_rows(two_households: Pair) -> None:
    a, b = two_households
    async with household_session(a.household_id) as s:
        updated = await s.execute(
            text("UPDATE people SET name = 'pwned' WHERE id = :p"), {"p": b.ids["person"]}
        )
        deleted = await s.execute(text("DELETE FROM photos WHERE id = :p"), {"p": b.ids["photo"]})
    assert updated.rowcount == 0  # type: ignore[attr-defined]
    assert deleted.rowcount == 0  # type: ignore[attr-defined]


async def test_cannot_move_own_row_into_another_household(two_households: Pair) -> None:
    a, b = two_households
    with pytest.raises(DBAPIError, match="row-level security"):
        async with household_session(a.household_id) as s:
            await s.execute(
                text("UPDATE people SET household_id = :b WHERE id = :p"),
                {"b": b.household_id, "p": a.ids["person"]},
            )


async def test_composite_fk_blocks_referencing_another_households_row(two_households: Pair) -> None:
    """FK checks bypass RLS; the (id, household_id) composite FK closes that gap."""
    a, b = two_households
    with pytest.raises(IntegrityError):
        async with household_session(a.household_id) as s:
            await s.execute(
                text(
                    "INSERT INTO device_people (household_id, device_id, person_id) "
                    "VALUES (:h, :d, :p)"
                ),
                {"h": a.household_id, "d": a.ids["device"], "p": b.ids["person"]},
            )


async def _second_session(household_id: uuid.UUID, movie_id: uuid.UUID) -> uuid.UUID:
    async with household_session(household_id) as s:
        sid = (
            await s.execute(
                text(
                    "INSERT INTO sessions (household_id, night_code_hash) "
                    "VALUES (:h, :c) RETURNING id"
                ),
                {"h": household_id, "c": uuid.uuid4().hex},
            )
        ).scalar_one()
        await s.execute(
            text("INSERT INTO options (household_id, session_id, movie_id) VALUES (:h, :s, :m)"),
            {"h": household_id, "s": sid, "m": movie_id},
        )
    result: uuid.UUID = sid
    return result


async def test_winner_must_be_an_option_of_the_same_session(two_households: Pair) -> None:
    a, _ = two_households
    other_session = await _second_session(a.household_id, a.ids["movie"])
    with pytest.raises(IntegrityError):
        async with household_session(a.household_id) as s:
            await s.execute(
                text("UPDATE sessions SET winner_option_id = :o WHERE id = :s"),
                {"o": a.ids["option"], "s": other_session},
            )


async def test_ballot_option_must_belong_to_the_ballots_session(two_households: Pair) -> None:
    a, _ = two_households
    other_session = await _second_session(a.household_id, a.ids["movie"])
    with pytest.raises(IntegrityError):
        async with household_session(a.household_id) as s:
            await s.execute(
                text(
                    "INSERT INTO ballot_ranks (household_id, session_id, person_id, option_id, "
                    "rank, cast_by_device_id) VALUES (:h, :s, :p, :o, 1, :d)"
                ),
                {
                    "h": a.household_id,
                    "s": other_session,
                    "p": a.ids["person"],
                    "o": a.ids["option"],
                    "d": a.ids["device"],
                },
            )


async def test_ballot_constraints_reject_bad_ranks(two_households: Pair) -> None:
    a, _ = two_households
    base = {
        "h": a.household_id,
        "s": a.ids["session"],
        "p": a.ids["person"],
        "d": a.ids["device"],
    }
    insert = text(
        "INSERT INTO ballot_ranks (household_id, session_id, person_id, option_id, rank, "
        "cast_by_device_id) VALUES (:h, :s, :p, :o, :r, :d)"
    )
    # rank 1 is already taken by the seeded ballot; same option twice; rank out of range
    # (1..8 since ADR-0010: an approval ballot may hold the whole shortlist).
    for params in (
        {**base, "o": a.ids["option2"], "r": 1},
        {**base, "o": a.ids["option"], "r": 2},
        {**base, "o": a.ids["option2"], "r": 9},
        {**base, "o": a.ids["option2"], "r": 0},
    ):
        with pytest.raises(IntegrityError):
            async with household_session(a.household_id) as s:
                await s.execute(insert, params)
