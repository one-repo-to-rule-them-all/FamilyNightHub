"""Night reel rules: the window and the stable order (ADR-0018 amendment)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from app.domain import reel

NOW = datetime(2026, 11, 26, 20, 30, tzinfo=UTC)


def test_window_tonight_is_twelve_hours_and_all_is_unbounded() -> None:
    assert reel.window_since("tonight", NOW) == NOW - timedelta(hours=12)
    assert reel.window_since("all", NOW) is None


def test_anchor_is_the_start_of_the_utc_day_and_does_not_move_within_it() -> None:
    assert reel.anchor_for(NOW) == datetime(2026, 11, 26, tzinfo=UTC)
    assert reel.anchor_for(NOW + timedelta(hours=2)) == reel.anchor_for(NOW)


def test_default_seed_is_per_household_and_day() -> None:
    h1, h2 = uuid.uuid4(), uuid.uuid4()
    assert reel.reel_seed(h1, NOW) == reel.reel_seed(h1, NOW + timedelta(hours=1))
    assert reel.reel_seed(h1, NOW) != reel.reel_seed(h2, NOW)
    assert reel.reel_seed(h1, NOW) != reel.reel_seed(h1, NOW + timedelta(days=1))


def test_order_ignores_input_order_and_duplicates() -> None:
    ids = [f"quote:{n}" for n in range(20)]
    assert reel.order_ids(ids, 5) == reel.order_ids(reversed(ids), 5)
    assert reel.order_ids(ids + ids, 5) == reel.order_ids(ids, 5)
    assert reel.order_ids(ids, 5) != reel.order_ids(ids, 6)


def test_a_new_id_does_not_reorder_the_others() -> None:
    ids = [f"photo:{n}" for n in range(30)]
    base = reel.order_ids(ids, 11)
    grown = reel.order_ids([*ids, "quote:new"], 11)
    assert [i for i in grown if i != "quote:new"] == base
    assert reel.order_ids([], 1) == []
