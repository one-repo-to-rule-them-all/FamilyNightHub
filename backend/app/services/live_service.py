"""Live updates: issue an SSE ticket for one night of the caller's household (ADR-0004)."""

from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.realtime.tickets import mint_ticket
from app.services.errors import NotFound


async def issue_ticket(db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID) -> str:
    """A ticket bound to (household, night); NotFound if the night isn't this household's."""
    found = await db.scalar(
        text("SELECT 1 FROM sessions WHERE id = :s AND household_id = :h"),
        {"s": session_id, "h": household_id},
    )
    if found is None:
        raise NotFound
    return await mint_ticket(household_id, session_id)


async def issue_game_ticket(db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID) -> str:
    """A ticket bound to (household, game); NotFound if the game isn't this household's."""
    found = await db.scalar(
        text("SELECT 1 FROM games WHERE id = :g AND household_id = :h"),
        {"g": game_id, "h": household_id},
    )
    if found is None:
        raise NotFound
    return await mint_ticket(household_id, game_id, scope="game")
