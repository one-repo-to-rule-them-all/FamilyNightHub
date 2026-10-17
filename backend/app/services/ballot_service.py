"""Ballots: cast or replace, proxy for kids, who has voted, read back your own (ADR-0006).

A ballot is the set of `ballot_ranks` rows for one (session, person); casting replaces
them in the request's one transaction. The session row is read `FOR SHARE`, so a ballot
in flight and `close_voting` (`FOR UPDATE`) serialize: a ballot either lands before the
tally or sees the night revealed and gets 409. Nothing here ever returns another
person's ranks; the TV and phones only learn *who* has voted (ADR-0004/0006).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import session_state
from app.domain.session_state import SessionRuleError
from app.domain.voting import BALLOT_CHECKS
from app.domain.voting.base import BallotError
from app.realtime import events
from app.realtime.publisher import publish_after_commit
from app.services import attendance_service, people_service
from app.services.errors import Conflict, Invalid, NotFound


@dataclass(frozen=True)
class Voter:
    person_id: uuid.UUID
    avatar_emoji: str
    color: str


@dataclass(frozen=True)
class OwnBallot:
    person_id: uuid.UUID
    # (option_id, rank) by rank; empty if this person hasn't voted.
    ranks: list[tuple[uuid.UUID, int]]


async def _open_for_votes(
    db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID
) -> tuple[list[uuid.UUID], int, str]:
    """Option ids, k and the voting method for a night that is taking votes; NotFound /
    Conflict otherwise."""
    row = (
        await db.execute(
            text(
                "SELECT status, ballot_size, voting_method FROM sessions "
                "WHERE id = :s AND household_id = :h FOR SHARE"
            ),
            {"s": session_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    try:
        session_state.check_can_vote(row.status)
    except SessionRuleError as err:
        raise Conflict(err.reason) from None
    options = await db.execute(
        text("SELECT id FROM options WHERE session_id = :s"), {"s": session_id}
    )
    return [o.id for o in options], int(row.ballot_size), row.voting_method


async def cast(
    db: AsyncSession,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    person_id: uuid.UUID,
    ranks: list[tuple[uuid.UUID, int]],
    *,
    device_id: uuid.UUID | None = None,
    proxy_account_id: uuid.UUID | None = None,
) -> None:
    """Replace `person_id`'s ballot. Exactly one of device_id (a phone voting as a person
    actively bound to it) or proxy_account_id (a host with `ballots:proxy`) is given.
    For approval the ranks are 1..m ordinals of the approvals (ADR-0010)."""
    assert (device_id is None) != (proxy_account_id is None)
    options, k, method = await _open_for_votes(db, household_id, session_id)
    if device_id is not None:
        await people_service.require_can_act_as(db, device_id, person_id)
    else:
        person = await db.scalar(
            text("SELECT 1 FROM people WHERE id = :p AND merged_into_id IS NULL"),
            {"p": person_id},
        )
        if person is None:
            raise NotFound("Person not found")
    try:
        # The night's method decides what a valid ballot is (ADR-0006, ADR-0010).
        check = BALLOT_CHECKS[method]
        check([str(o) for o in options], k, [(str(o), r) for o, r in ranks])
    except BallotError as err:
        raise Invalid(err.reason) from None

    await db.execute(
        text("DELETE FROM ballot_ranks WHERE session_id = :s AND person_id = :p"),
        {"s": session_id, "p": person_id},
    )
    for option_id, rank in ranks:
        await db.execute(
            text(
                "INSERT INTO ballot_ranks (household_id, session_id, person_id, option_id, "
                "rank, cast_by_device_id, cast_by_account_id, is_proxy) "
                "VALUES (:h, :s, :p, :o, :r, :d, :a, :proxy)"
            ),
            {
                "h": household_id,
                "s": session_id,
                "p": person_id,
                "o": option_id,
                "r": rank,
                "d": device_id,
                "a": proxy_account_id,
                "proxy": proxy_account_id is not None,
            },
        )
    if proxy_account_id is not None:
        # Who voted for whom is auditable; what they ranked is not.
        await db.execute(
            text(
                "INSERT INTO audit_events (household_id, actor_account_id, action, "
                "target_type, target_id, data) VALUES (:h, :a, 'ballot.proxy_cast', "
                "'session', :s, jsonb_build_object('person_id', CAST(:p AS text)))"
            ),
            {"h": household_id, "a": proxy_account_id, "s": session_id, "p": str(person_id)},
        )
    # The hint says only "the turnout changed": phones and the TV refetch `voters`.
    publish_after_commit(db, session_id, events.BALLOT_COUNT)
    if device_id is not None:
        # Voting from a phone set to them: they're here (G8). Proxy voters show up in
        # `present` through their ballot.
        await attendance_service.mark_present(db, household_id, session_id, person_id)


async def _exists(db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID) -> None:
    found = await db.scalar(
        text("SELECT 1 FROM sessions WHERE id = :s AND household_id = :h"),
        {"s": session_id, "h": household_id},
    )
    if found is None:
        raise NotFound


async def voters(db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID) -> list[Voter]:
    """Who has a ballot in: avatars only, never ranks."""
    await _exists(db, household_id, session_id)
    rows = await db.execute(
        text(
            """
            SELECT p.id, p.avatar_emoji, p.color FROM people p
            WHERE EXISTS (
                SELECT 1 FROM ballot_ranks br WHERE br.session_id = :s AND br.person_id = p.id
            )
            ORDER BY p.is_guest, lower(p.name)
            """
        ),
        {"s": session_id},
    )
    return [Voter(r.id, r.avatar_emoji, r.color) for r in rows]


async def own_ballots(
    db: AsyncSession, household_id: uuid.UUID, device_id: uuid.UUID, session_id: uuid.UUID
) -> list[OwnBallot]:
    """The ballots of the people actively bound to this device (pending claims excluded)."""
    await _exists(db, household_id, session_id)
    rows = await db.execute(
        text(
            """
            SELECT dp.person_id, br.option_id, br.rank
            FROM device_people dp
            JOIN people p ON p.id = dp.person_id
            LEFT JOIN ballot_ranks br ON br.person_id = dp.person_id AND br.session_id = :s
            WHERE dp.device_id = :d AND dp.status = 'active'
            ORDER BY p.is_guest, lower(p.name), dp.person_id, br.rank
            """
        ),
        {"s": session_id, "d": device_id},
    )
    ballots: dict[uuid.UUID, list[tuple[uuid.UUID, int]]] = {}
    for r in rows:
        ranks = ballots.setdefault(r.person_id, [])
        if r.option_id is not None:
            ranks.append((r.option_id, r.rank))
    return [OwnBallot(pid, ranks) for pid, ranks in ballots.items()]
