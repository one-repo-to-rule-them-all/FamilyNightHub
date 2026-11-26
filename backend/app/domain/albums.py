"""Night albums (ADR-0019): which calendar "night" a moment belongs to, and its upload window.

Pure functions, no I/O. A night date is the household's local date with a 4:00 cutoff, so a
photo taken at 1:30 on Friday morning still belongs to Thursday's family night. The cutoff is
applied to the local wall clock, so it stays at 04:00 local across a DST change.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from functools import cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

CUTOFF = timedelta(hours=4)
# Owner answer 3: a past album takes uploads for its night date plus 3 days, then is read-only.
UPLOAD_GRACE_DAYS = 3
DEFAULT_TIMEZONE = "America/Chicago"
MAX_TITLE = 80


def night_date(now: datetime, tz: str, cutoff: timedelta = CUTOFF) -> date:
    """The household-local night date of an aware instant."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    local = now.astimezone(ZoneInfo(tz))
    # Wall-clock arithmetic (same tzinfo): 03:59 local is still the previous night.
    return (local.replace(tzinfo=None) - cutoff).date()


def uploads_open(album_night: date, today: date) -> bool:
    """`today` is the current night date. Future albums don't exist; past ones close."""
    return album_night <= today <= album_night + timedelta(days=UPLOAD_GRACE_DAYS)


def default_title(d: date) -> str:
    """The date label the UI shows until a host renames the album, e.g. "Thu 26 Nov"."""
    return f"{d:%a} {d.day} {d:%b}"


@cache
def _zones() -> frozenset[str]:
    return frozenset(available_timezones())


def is_valid_timezone(name: str) -> bool:
    if not name or name != name.strip() or name.startswith("/") or ".." in name:
        return False
    if name not in _zones():
        return False
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    return True
