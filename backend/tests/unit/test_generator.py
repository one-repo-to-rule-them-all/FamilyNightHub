"""Candidate generator (ADR-0007): worked examples plus Hypothesis properties."""

from __future__ import annotations

import random
import uuid

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.domain import generator as g
from app.domain.generator import Candidate, Filters, History, Pools, Title


def t(tmdb_id: int, **kw: object) -> Title:
    base: dict[str, object] = {"title": f"T{tmdb_id}", "tmdb_id": tmdb_id, "us_cert": "PG"}
    base.update(kw)
    return Title(**base)  # type: ignore[arg-type]


def ids(out: list[Candidate]) -> list[int | None]:
    return [c.title.tmdb_id for c in out]


def run(
    pools: Pools,
    filters: Filters | None = None,
    history: History | None = None,
    blocked: set[g.Key] | None = None,
    seed: int = 1,
    count: int = 10,
) -> list[Candidate]:
    return g.generate(
        pools,
        filters or Filters(),
        history or History(),
        blocked or set(),
        random.Random(seed),
        count,
    )


# --- Worked examples -----------------------------------------------------------------


def test_sources_come_in_order_owned_streaming_anywhere() -> None:
    pools = Pools(owned=[t(1), t(2)], streaming=[t(3)], anywhere=[t(4), t(5)])
    out = run(pools, count=4)
    assert [c.source for c in out] == ["owned", "owned", "streaming", "tmdb"]
    assert set(ids(out[:2])) == {1, 2}
    assert out[2].title.tmdb_id == 3


def test_owned_alone_can_fill_the_roll() -> None:
    out = run(Pools(owned=[t(i) for i in range(10)], anywhere=[t(99)]), count=3)
    assert [c.source for c in out] == ["owned"] * 3


def test_fewer_than_count_when_pools_run_dry() -> None:
    assert ids(run(Pools(anywhere=[t(1)]), count=5)) == [1]
    assert run(Pools(), count=5) == []


def test_no_duplicates_across_pools() -> None:
    movie = uuid.uuid4()
    pools = Pools(
        owned=[t(1, movie_id=movie)],
        streaming=[t(1), t(2)],
        anywhere=[t(2), Title("same row", movie_id=movie), t(3)],
    )
    out = run(pools, count=10)
    assert sorted(ids(out), key=str) == [1, 2, 3]
    assert out[0].source == "owned"
    assert [c.source for c in out if c.title.tmdb_id == 2] == ["streaming"]


def test_titles_without_any_id_are_ignored() -> None:
    assert run(Pools(owned=[Title("ghost")])) == []


def test_blocked_titles_are_always_skipped() -> None:
    movie = uuid.uuid4()
    pools = Pools(owned=[Title("blocked row", movie_id=movie, us_cert="G")], anywhere=[t(1), t(2)])
    out = run(pools, blocked={("movie", movie), ("tmdb", 2)})
    assert ids(out) == [1]


def test_age_cap_excludes_over_cap_and_unrated() -> None:
    pools = Pools(
        anywhere=[
            t(1, us_cert="G"),
            t(2, us_cert="PG-13"),
            t(3, us_cert="R"),
            t(4, us_cert=None),
            t(5, us_cert="NR"),
            t(6, us_cert=""),
        ]
    )
    assert sorted(ids(run(pools, Filters(age_cap="PG-13")))) == [1, 2]  # type: ignore[type-var]
    assert len(run(pools)) == 6  # uncapped nights take unrated too


def test_cap_ladder() -> None:
    assert g.within_cap("G", "G")
    assert not g.within_cap("PG", "G")
    assert g.within_cap("R", "NC-17")
    assert g.within_cap(None, None)
    assert not g.within_cap("TV-MA", "R")


def test_genre_filter_needs_the_genre() -> None:
    pools = Pools(
        anywhere=[
            t(1, genres=frozenset({"Animation", "Family"})),
            t(2, genres=frozenset({"Horror"})),
            t(3),
        ]
    )
    assert ids(run(pools, Filters(genre="Family"))) == [1]


def test_max_runtime_skips_long_titles_but_trusts_unknown() -> None:
    pools = Pools(anywhere=[t(1, runtime=90), t(2, runtime=121), t(3, runtime=None)])
    assert sorted(ids(run(pools, Filters(max_runtime=120)))) == [1, 3]  # type: ignore[type-var]


def test_recently_watched_is_skipped_unless_rated_four_or_more() -> None:
    movie = uuid.uuid4()
    pools = Pools(
        owned=[Title("loved", movie_id=movie, us_cert="PG")],
        anywhere=[t(1), t(2), t(3), t(4)],
    )
    history = History(
        {("movie", movie): 4.0, ("tmdb", 1): 3.99, ("tmdb", 2): None, ("tmdb", 3): 4.5}
    )
    out = run(pools, history=history)
    assert out[0].title.movie_id == movie
    assert sorted(ids(out[1:])) == [3, 4]  # type: ignore[type-var]


def test_same_seed_same_roll_and_seeds_differ() -> None:
    pools = Pools(anywhere=[t(i) for i in range(30)])
    assert ids(run(pools, seed=5)) == ids(run(pools, seed=5))
    assert ids(run(pools, seed=5)) != ids(run(pools, seed=6))


def test_bad_count_and_bad_cap_are_rejected() -> None:
    for count in (0, g.MAX_COUNT + 1):
        with pytest.raises(ValueError, match="count"):
            run(Pools(), count=count)
    with pytest.raises(ValueError, match="age cap"):
        run(Pools(), Filters(age_cap="TV-14"))


def test_keys_and_genre_tables() -> None:
    movie = uuid.uuid4()
    assert g.keys_of(5, movie) == {("tmdb", 5), ("movie", movie)}
    assert g.keys_of(None, None) == frozenset()
    assert g.GENRE_NAMES[g.GENRES["Family"]] == "Family"


# --- Properties ----------------------------------------------------------------------

CERTS = st.sampled_from([None, "", "NR", *g.US_CERTS])
GENRE = st.sampled_from(sorted(g.GENRES))


@st.composite
def titles(draw: st.DrawFn) -> Title:
    return Title(
        title="x",
        tmdb_id=draw(st.integers(1, 40)),
        genres=frozenset(draw(st.sets(GENRE, max_size=3))),
        runtime=draw(st.none() | st.integers(60, 200)),
        us_cert=draw(CERTS),
    )


POOL = st.lists(titles(), max_size=15)
FILTERS = st.builds(
    Filters,
    genre=st.none() | GENRE,
    max_runtime=st.none() | st.integers(60, 200),
    age_cap=st.none() | st.sampled_from(g.US_CERTS),
)
HISTORY = st.dictionaries(
    st.tuples(st.just("tmdb"), st.integers(1, 40)),
    st.none() | st.floats(1, 5),
    max_size=10,
).map(History)
BLOCKED = st.sets(st.tuples(st.just("tmdb"), st.integers(1, 40)), max_size=10)


@settings(max_examples=200)
@given(
    owned=POOL,
    streaming=POOL,
    anywhere=POOL,
    filters=FILTERS,
    history=HISTORY,
    blocked=BLOCKED,
    seed=st.integers(0, 2**32),
    count=st.integers(1, g.MAX_COUNT),
)
def test_properties(
    owned: list[Title],
    streaming: list[Title],
    anywhere: list[Title],
    filters: Filters,
    history: History,
    blocked: set[g.Key],
    seed: int,
    count: int,
) -> None:
    pools = Pools(owned, streaming, anywhere)
    out = g.generate(pools, filters, history, blocked, random.Random(seed), count)
    again = g.generate(pools, filters, history, blocked, random.Random(seed), count)

    # Deterministic for a seed.
    assert out == again
    assert len(out) <= count
    # No duplicates.
    assert len({c.title.tmdb_id for c in out}) == len(out)
    for c in out:
        # Never blocked, never over the cap (and never unrated on a capped night).
        assert ("tmdb", c.title.tmdb_id) not in blocked
        assert g.within_cap(c.title.us_cert, filters.age_cap)
        if filters.age_cap is not None:
            assert c.title.us_cert in g.US_CERTS
        # Recently watched only when rescued by the family's rating.
        avg = history.watched.get(("tmdb", c.title.tmdb_id), 5.0)
        assert avg is not None and avg >= g.RESCUE_RATING
    # Owned before others; a qualifying owned title is only left out when owned filled it.
    sources = [c.source for c in out]
    assert sources == sorted(sources, key=["owned", "streaming", "tmdb"].index)
    qualifying_owned = {o.tmdb_id for o in owned if g.eligible(o, filters, history, blocked)}
    picked_owned = {c.title.tmdb_id for c in out if c.source == "owned"}
    if qualifying_owned - picked_owned:
        assert sources == ["owned"] * count


def test_the_api_genre_list_is_tmdbs() -> None:
    from typing import get_args

    from app.schemas.sessions import Genre

    assert set(get_args(Genre)) == set(g.GENRES)
