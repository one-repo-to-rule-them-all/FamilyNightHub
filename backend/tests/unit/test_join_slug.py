"""Join slugs (ADR-0002): readable, unambiguous, valid for the bootstrap slug rule."""

from __future__ import annotations

import re
from itertools import cycle

from app.cli import SLUG
from app.domain import join_slug


def test_shape_and_alphabet() -> None:
    for _ in range(200):
        slug = join_slug.generate()
        assert re.fullmatch(r"[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}", slug)
        assert not set(slug) & set("01oil")
        assert SLUG.match(slug)  # the CLI would accept it too


def test_choice_is_injectable() -> None:
    letters = cycle("abc")
    assert join_slug.generate(lambda _alphabet: next(letters)) == "abca-bcab-cabc"
