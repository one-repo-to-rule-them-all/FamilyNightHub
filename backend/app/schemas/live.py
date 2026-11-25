"""Live updates (ADR-0004, ADR-0018): the SSE ticket request and response."""

from __future__ import annotations

import uuid

from pydantic import BaseModel, model_validator


class SseTicketIn(BaseModel):
    # Exactly one: a night's stream or a game's stream.
    session_id: uuid.UUID | None = None
    game_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> SseTicketIn:
        if (self.session_id is None) == (self.game_id is None):
            raise ValueError("Send exactly one of session_id or game_id")
        return self


class SseTicketOut(BaseModel):
    # Opaque, single-use; open `GET /sessions/{id}/stream?ticket=` (or `/games/{id}/stream`)
    # within expires_in.
    ticket: str
    expires_in: int
