"""GET /people/{id}/profile (ADR-0014 "Profiles"): revealed nights only, household-scoped."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import text

from app.core.database import household_session
from tests.integration.phones import Phone, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "WXYZAB"


def _url(person_id: uuid.UUID) -> str:
    return f"/api/v1/people/{person_id}/profile"


async def _set(household: SeededHousehold, sql: str, **params: Any) -> None:
    async with household_session(household.household_id) as db:
        await db.execute(text(sql), params)


async def _profile(p: Phone, person_id: uuid.UUID) -> dict[str, Any]:
    resp = await p.client.get(_url(person_id))
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


async def test_ballots_stay_hidden_until_the_reveal(two_households: Pair) -> None:
    """The seed's Kid has a ballot (rank 1 on Paddington), a rating and a photo in the
    seeded night. While the night is voting, the profile must not show any of it."""
    a, _ = two_households
    kid, sid = a.ids["person"], a.ids["session"]
    await open_night(a.household_id, sid, CODE, status="voting")
    async with phone() as p:
        assert (await p.join(a.slug, CODE)).status_code == 200
        during = await _profile(p, kid)
        await _set(
            a,
            "UPDATE sessions SET status = 'closed', revealed_at = now() - interval '1 hour', "
            "closed_at = now(), winner_option_id = :o WHERE id = :s",
            o=a.ids["option"],
            s=sid,
        )
        await _set(a, "UPDATE photos SET status = 'ready' WHERE id = :p", p=a.ids["photo"])
        after = await _profile(p, kid)

    assert during["nights"] == [] and during["albums"] == []
    assert during["stats"] == {
        "nights_joined": 0,
        "ballots_cast": 0,
        "winners_picked": 0,
        "ratings_given": 0,
        "average_rating_given": None,
        "photos_uploaded": 0,
    }
    assert str(a.ids["option"]) not in str(during)

    [night] = after["nights"]
    assert night["session_id"] == str(sid)
    assert night["status"] == "closed"
    assert night["winner"]["title"] == "Paddington"
    assert [(pk["option_id"], pk["rank"], pk["movie"]["title"]) for pk in night["picks"]] == [
        (str(a.ids["option"]), 1, "Paddington")
    ]
    assert night["picked_winner"] is True
    assert (night["rating"], night["photo_count"]) == (5, 1)
    assert after["albums"] == [
        {
            "session_id": str(sid),
            "title": None,
            "photo_count": 1,
            "photos_url": f"/api/v1/sessions/{sid}/photos",
        }
    ]
    assert after["stats"] == {
        "nights_joined": 1,
        "ballots_cast": 1,
        "winners_picked": 1,
        "ratings_given": 1,
        "average_rating_given": 5.0,
        "photos_uploaded": 1,
    }


async def test_a_lost_pick_is_not_a_winner_and_approval_counts_any_approval(
    two_households: Pair,
) -> None:
    a, _ = two_households
    kid, sid = a.ids["person"], a.ids["session"]
    # Revealed (not yet settled), the second option won: Kid's rank-1 pick lost.
    await _set(
        a,
        "UPDATE sessions SET status = 'revealed', revealed_at = now(), winner_option_id = :o "
        "WHERE id = :s",
        o=a.ids["option2"],
        s=sid,
    )
    async with phone() as admin:
        admin.sign_in_as(a.ids["account"], a.household_id)
        ranked = await _profile(admin, kid)
        await _set(
            a,
            "INSERT INTO ballot_ranks (household_id, session_id, person_id, option_id, rank, "
            "cast_by_account_id) VALUES (:h, :s, :p, :o, 2, :a)",
            h=a.household_id,
            s=sid,
            p=kid,
            o=a.ids["option2"],
            a=a.ids["account"],
        )
        await _set(a, "UPDATE sessions SET voting_method = 'approval' WHERE id = :s", s=sid)
        approval = await _profile(admin, kid)
    assert ranked["nights"][0]["status"] == "revealed"
    assert ranked["nights"][0]["picked_winner"] is False
    assert ranked["stats"]["winners_picked"] == 0
    assert approval["nights"][0]["picked_winner"] is True
    assert len(approval["nights"][0]["picks"]) == 2


async def test_profile_is_household_scoped_and_hides_merged_people(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as admin, phone() as nobody:
        admin.sign_in_as(a.ids["account"], a.household_id)
        own = await admin.client.get(_url(a.ids["person"]))
        other = await admin.client.get(_url(b.ids["person"]))
        missing = await admin.client.get(_url(uuid.uuid4()))
        anonymous = await nobody.client.get(_url(a.ids["person"]))
        async with household_session(a.household_id) as db:
            twin: uuid.UUID = (
                await db.execute(
                    text(
                        "INSERT INTO people (household_id, name, avatar_emoji, color, "
                        "merged_into_id) VALUES (:h, 'Old Kid', '🦖', '#000000', :m) RETURNING id"
                    ),
                    {"h": a.household_id, "m": a.ids["person"]},
                )
            ).scalar_one()
        merged = await admin.client.get(_url(twin))
    assert own.status_code == 200 and own.json()["name"] == "Kid"
    assert (other.status_code, missing.status_code, merged.status_code) == (404, 404, 404)
    assert anonymous.status_code == 401
