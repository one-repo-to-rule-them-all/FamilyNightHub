"""ADR-0019: the night date (household-local, 4:00 cutoff), the upload window and labels."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.domain import albums

CHI = "America/Chicago"


def _local(y: int, mo: int, d: int, h: int, mi: int = 0, tz: str = CHI) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=ZoneInfo(tz))


@pytest.mark.parametrize(
    ("moment", "expected"),
    [
        (_local(2026, 11, 26, 19, 0), date(2026, 11, 26)),  # Thanksgiving evening
        (_local(2026, 11, 26, 23, 59), date(2026, 11, 26)),
        (_local(2026, 11, 27, 0, 0), date(2026, 11, 26)),  # midnight: still Thursday's night
        (_local(2026, 11, 27, 1, 30), date(2026, 11, 26)),
        (_local(2026, 11, 27, 3, 59), date(2026, 11, 26)),
        (_local(2026, 11, 27, 4, 0), date(2026, 11, 27)),  # the cutoff starts a new day
        (_local(2026, 11, 27, 10, 0), date(2026, 11, 27)),
    ],
)
def test_night_date_cutoff_around_midnight(moment: datetime, expected: date) -> None:
    assert albums.night_date(moment, CHI) == expected
    # The same instant in UTC gives the same answer: the tz decides, not the input's offset.
    assert albums.night_date(moment.astimezone(UTC), CHI) == expected


def test_night_date_uses_the_household_timezone() -> None:
    instant = datetime(2026, 11, 27, 3, 0, tzinfo=UTC)  # 21:00 Thu in Chicago, 03:00 Fri UTC
    assert albums.night_date(instant, CHI) == date(2026, 11, 26)
    assert albums.night_date(instant, "Europe/London") == date(2026, 11, 26)  # 03:00 < 04:00
    assert albums.night_date(instant, "Asia/Tokyo") == date(2026, 11, 27)  # 12:00 Fri


def test_night_date_dst_fall_back() -> None:
    # 1 Nov 2026: Chicago repeats 01:00-02:00. Both 01:30s belong to Saturday 31 Oct.
    first = datetime(2026, 11, 1, 6, 30, tzinfo=UTC)  # 01:30 CDT
    second = datetime(2026, 11, 1, 7, 30, tzinfo=UTC)  # 01:30 CST
    assert albums.night_date(first, CHI) == date(2026, 10, 31)
    assert albums.night_date(second, CHI) == date(2026, 10, 31)
    # 04:00 local wall clock (CST, 10:00 UTC) starts Sunday; 03:59 is still Saturday.
    assert albums.night_date(datetime(2026, 11, 1, 9, 59, tzinfo=UTC), CHI) == date(2026, 10, 31)
    assert albums.night_date(datetime(2026, 11, 1, 10, 0, tzinfo=UTC), CHI) == date(2026, 11, 1)


def test_night_date_dst_spring_forward() -> None:
    # 8 Mar 2026: Chicago skips 02:00-03:00. The cutoff stays at 04:00 local (CDT, 09:00 UTC).
    assert albums.night_date(datetime(2026, 3, 8, 8, 59, tzinfo=UTC), CHI) == date(2026, 3, 7)
    assert albums.night_date(datetime(2026, 3, 8, 9, 0, tzinfo=UTC), CHI) == date(2026, 3, 8)


def test_night_date_rejects_naive_datetimes() -> None:
    with pytest.raises(ValueError):
        albums.night_date(datetime(2026, 11, 26, 19, 0), CHI)  # noqa: DTZ001


def test_upload_window_is_the_night_plus_three_days() -> None:
    night = date(2026, 11, 26)
    assert albums.uploads_open(night, night)
    assert albums.uploads_open(night, night + timedelta(days=3))
    assert not albums.uploads_open(night, night + timedelta(days=4))
    assert not albums.uploads_open(night, night - timedelta(days=1))


def test_default_title_is_a_short_date_label() -> None:
    assert albums.default_title(date(2026, 11, 26)) == "Thu 26 Nov"
    assert albums.default_title(date(2026, 12, 5)) == "Sat 5 Dec"


@pytest.mark.parametrize("name", ["America/Chicago", "Europe/London", "UTC", "Asia/Kolkata"])
def test_valid_timezones(name: str) -> None:
    assert albums.is_valid_timezone(name)


@pytest.mark.parametrize(
    "name", ["", "Mars/Olympus", "america/chicago", " America/Chicago", "../etc/passwd", "CST6"]
)
def test_invalid_timezones(name: str) -> None:
    assert not albums.is_valid_timezone(name)
