"""The live-event registry: the one list of what may go on `session:{id}` (ADR-0004).

Adapted from OrderUp backend/app/realtime/events.py @ 2f86cd8 (issue #157 there: a name a
publisher sends and no consumer expects fails silently). FNH has one channel, and its
frames are *unnamed* SSE `data:` frames whose JSON carries `type`, so a browser's
`onmessage` sees every event without registering per-name listeners. The registry still
guards the publish side: an unknown type is a programming error and raises.

Every event is a hint: `{type, session_id, version}` and nothing else. Clients refetch the
snapshot (`GET /sessions/{id}`) or `GET …/voters`; events never carry ballots, ranks or
tallies (ADR-0004/0006).
"""

from __future__ import annotations

# Wire channel is `session:{session_id}`; this is the prefix.
SESSION = "session"

STATUS_CHANGED = "status_changed"  # open-voting, close (tonight -> closed)
SHORTLIST_CHANGED = "shortlist_changed"  # option added/removed/reordered; method changed
BALLOT_COUNT = "ballot_count"  # someone's ballot landed; refetch who has voted
REVEALED = "revealed"  # close-voting tallied the night
PHOTO_ADDED = "photo_added"  # photos PR (#10) publishes this once an upload completes
RATING_COUNT = "rating_count"  # someone rated the night; refetch the family average
WINNER_CORRECTED = "winner_corrected"  # an admin corrected the night's winner (ADR-0006)

PUBLISHED_EVENTS: frozenset[str] = frozenset(
    {
        STATUS_CHANGED,
        SHORTLIST_CHANGED,
        BALLOT_COUNT,
        REVEALED,
        PHOTO_ADDED,
        RATING_COUNT,
        WINNER_CORRECTED,
    }
)

# Synthesized by the stream itself, never published: the Redis subscription gave up, so
# the client should fall back to polling and re-ticket.
DEGRADED = "degraded"
TRANSPORT_EVENTS: frozenset[str] = frozenset({DEGRADED})


class UnknownLiveEventError(ValueError):
    """A publisher was handed a type this registry does not know. Raised even on the
    best-effort publish path: a Redis blip heals itself, a typo never does."""


def assert_registered(event_type: str) -> None:
    if event_type not in PUBLISHED_EVENTS:
        raise UnknownLiveEventError(
            f"{event_type!r} is not a live event (known: {sorted(PUBLISHED_EVENTS)}); "
            "add it to app/realtime/events.py"
        )
