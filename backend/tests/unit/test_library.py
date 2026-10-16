"""Bulk-add matching rules (domain/library.py) and the winner-correction rule."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.domain import library, session_state
from app.domain.session_state import SessionRuleError


@dataclass(frozen=True)
class Hit:
    title: str
    year: int | None


TOY = [Hit("Toy Story", 1995), Hit("Toy Story 2", 1999), Hit("Toy Story 3", 2010)]


def test_title_key_ignores_case_accents_punctuation_and_spacing() -> None:
    assert library.title_key("WALL·E") == library.title_key("wall-e") == "walle"
    assert library.title_key("  Amélie ") == library.title_key("AMELIE")
    assert library.title_key("Up") != library.title_key("Upside")


def test_one_exact_title_is_a_match_even_among_sequels() -> None:
    match = library.classify("toy story", None, TOY)
    assert match.verdict == "matched"
    assert match.picks == (TOY[0],)


def test_no_exact_title_is_ambiguous_with_the_top_candidates() -> None:
    many = [Hit(f"Toy {i}", 2000 + i) for i in range(8)]
    match = library.classify("Toy", None, many)
    assert match.verdict == "ambiguous"
    assert match.picks == tuple(many[: library.MAX_CANDIDATES])


def test_remakes_with_the_same_title_are_ambiguous() -> None:
    remakes = [Hit("The Lion King", 1994), Hit("The Lion King", 2019), Hit("Lion", 2016)]
    match = library.classify("the lion king", None, remakes)
    assert match.verdict == "ambiguous"
    assert match.picks == tuple(remakes[:2])


def test_a_year_picks_between_remakes() -> None:
    remakes = [Hit("The Lion King", 1994), Hit("The Lion King", 2019)]
    match = library.classify("The Lion King", 2019, remakes)
    assert match.verdict == "matched"
    assert match.picks == (remakes[1],)


def test_a_year_with_one_result_matches_a_loose_spelling() -> None:
    match = library.classify("Toy Story Two", 1999, TOY)
    assert match.verdict == "matched"
    assert match.picks == (TOY[1],)


def test_a_year_with_several_loose_results_is_ambiguous() -> None:
    hits = [Hit("Paddington", 2014), Hit("Paddington Bear", 2014)]
    assert library.classify("Paddingtn", 2014, hits).verdict == "ambiguous"


@pytest.mark.parametrize(
    ("results", "year"),
    [([], None), (TOY, 1980)],
)
def test_nothing_left_is_not_found(results: list[Hit], year: int | None) -> None:
    match = library.classify("Toy Story", year, results)
    assert match.verdict == "not_found"
    assert match.picks == ()


@pytest.mark.parametrize("status", ["revealed", "tonight", "closed"])
def test_a_night_with_a_winner_can_be_corrected(status: str) -> None:
    session_state.check_can_correct_winner(status)


@pytest.mark.parametrize("status", ["draft", "voting"])
def test_a_night_without_a_winner_cannot(status: str) -> None:
    with pytest.raises(SessionRuleError):
        session_state.check_can_correct_winner(status)
