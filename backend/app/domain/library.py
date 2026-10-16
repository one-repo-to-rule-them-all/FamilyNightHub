"""Bulk add of owned titles: deciding what a typed line matched on TMDB (ADR-0007).

Pure: the service hands over TMDB's search results for one typed line and gets back a
verdict. A line is only auto-matched when there is exactly one sensible answer, because a
wrong "owned" title silently skews every generator roll; anything else goes back to the
admin with the top candidates.

- A year narrows the results to that release year first.
- One result whose title equals the typed title (ignoring case, punctuation and spacing)
  is a match. Two or more such titles (remakes) are ambiguous.
- With a year and exactly one result in that year, it is a match even if the title is
  spelled differently ("Wall-E (2008)").
- Otherwise any results are ambiguous, and none is not found.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Literal, Protocol

MAX_CANDIDATES = 5

Verdict = Literal["matched", "ambiguous", "not_found"]


class Titled(Protocol):
    @property
    def title(self) -> str: ...

    @property
    def year(self) -> int | None: ...


@dataclass(frozen=True)
class Match[T: Titled]:
    verdict: Verdict
    # The match for `matched`; the candidates for `ambiguous` (at most MAX_CANDIDATES).
    picks: tuple[T, ...]


def title_key(title: str) -> str:
    """Case-, accent-, punctuation- and spacing-insensitive form of a title."""
    decomposed = unicodedata.normalize("NFKD", title.casefold())
    return "".join(ch for ch in decomposed if ch.isalnum())


def classify[T: Titled](typed_title: str, typed_year: int | None, results: list[T]) -> Match[T]:
    pool = results if typed_year is None else [r for r in results if r.year == typed_year]
    if not pool:
        return Match("not_found", ())
    key = title_key(typed_title)
    exact = [r for r in pool if title_key(r.title) == key]
    if len(exact) == 1:
        return Match("matched", (exact[0],))
    if typed_year is not None and len(pool) == 1:
        return Match("matched", (pool[0],))
    return Match("ambiguous", tuple((exact or pool)[:MAX_CANDIDATES]))
