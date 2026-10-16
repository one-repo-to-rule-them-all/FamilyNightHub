from __future__ import annotations

import random

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain import night_code


def test_generate_uses_alphabet_and_length() -> None:
    code = night_code.generate()
    assert len(code) == night_code.LENGTH
    assert set(code) <= set(night_code.ALPHABET)


def test_generate_is_deterministic_with_injected_choice() -> None:
    a = night_code.generate(random.Random(7).choice)
    b = night_code.generate(random.Random(7).choice)
    assert a == b


def test_alphabet_has_no_ambiguous_characters() -> None:
    assert not set("0O1IL") & set(night_code.ALPHABET)
    assert len(night_code.ALPHABET) == 31


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("ABC234", "ABC234"),
        ("abc234", "ABC234"),
        (" abc-234 ", "ABC234"),
        ("ab_c 2-34", "ABC234"),
        ("ABC23", None),  # too short
        ("ABC2345", None),  # too long
        ("ABC0O1", None),  # ambiguous characters are never valid
        ("", None),
        ("ÄBC234", None),
    ],
)
def test_normalize(raw: str, expected: str | None) -> None:
    assert night_code.normalize(raw) == expected


@given(st.text(alphabet=night_code.ALPHABET, min_size=6, max_size=6))
def test_normalize_round_trips_any_valid_code(code: str) -> None:
    assert night_code.normalize(code.lower()) == code


@pytest.mark.parametrize(
    ("status", "joinable"),
    [("draft", True), ("voting", True), ("revealed", True), ("tonight", True), ("closed", False)],
)
def test_accepts_joins(status: str, joinable: bool) -> None:
    assert night_code.accepts_joins(status) is joinable
