"""Thanksgiving Scattergories rules (ADR-0018, section 4). Pure: no I/O, no clock.

Randomness is injected as a `random.Random`. Scoring is derived on read from the answers
and host verdicts and never stored, so a verdict change cannot leave a stale score.
"""

from __future__ import annotations

import random
import unicodedata
from collections import defaultdict
from collections.abc import Mapping, Sequence

# ADR-0018: Q, U, V, X, Y and Z are never drawn.
EXCLUDED_LETTERS = frozenset("QUVXYZ")
LETTERS: tuple[str, ...] = tuple(
    c for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if c not in EXCLUDED_LETTERS
)
ARTICLES = frozenset({"a", "an", "the"})
REJECTED = "rejected"

Answer = tuple[str, int, str]  # (person_id, category_index, text)
Verdicts = Mapping[tuple[str, int], str | None]  # (person_id, category_index) -> verdict


def draw_letter(rng: random.Random) -> str:
    return rng.choice(LETTERS)


def draw_categories(pool: Sequence[str], rng: random.Random, n: int) -> list[str]:
    """`n` distinct categories from the pool, in draw order."""
    if not 0 <= n <= len(pool):
        raise ValueError(f"Cannot draw {n} categories from a pool of {len(pool)}")
    return rng.sample(list(pool), n)


def normalize(text: str) -> str:
    """Casefold, strip accents and punctuation, drop leading a/an/the, collapse spaces."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    kept = "".join(c for c in decomposed if c.isspace() or unicodedata.category(c)[0] in "LN")
    words = kept.casefold().split()
    while len(words) > 1 and words[0] in ARTICLES:
        words.pop(0)
    return " ".join(words)


def is_valid(answer: str, letter: str, verdict: str | None) -> bool:
    """Starts with the round's letter after normalising, and not rejected by the host."""
    if verdict == REJECTED:
        return False
    return normalize(answer).startswith(normalize(letter))


def answer_points(
    answers: Sequence[Answer], verdicts: Verdicts, *, letter: str
) -> dict[tuple[str, int], int]:
    """(person_id, category_index) -> 1 for a valid answer unique among valid answers in its
    category, else 0."""
    valid: dict[int, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for person_id, category_index, text in answers:
        if is_valid(text, letter, verdicts.get((person_id, category_index))):
            valid[category_index][normalize(text)].add(person_id)
    return {
        (person_id, category_index): int(
            len(valid[category_index].get(normalize(text), ())) == 1
            and person_id in valid[category_index].get(normalize(text), ())
        )
        for person_id, category_index, text in answers
    }


def score_round(answers: Sequence[Answer], verdicts: Verdicts, *, letter: str) -> dict[str, int]:
    """person_id -> points. A valid answer unique among valid answers in its category is 1."""
    scores = {person_id: 0 for person_id, _, _ in answers}
    for (person_id, _), point in answer_points(answers, verdicts, letter=letter).items():
        scores[person_id] += point
    return scores
