"""Live updates (ADR-0004): the SSE ticket request and response."""

from __future__ import annotations

import uuid

from pydantic import BaseModel


class SseTicketIn(BaseModel):
    session_id: uuid.UUID


class SseTicketOut(BaseModel):
    # Opaque, single-use; open `GET /sessions/{session_id}/stream?ticket=` within expires_in.
    ticket: str
    expires_in: int
