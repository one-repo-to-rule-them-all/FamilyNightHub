"""Thanksgiving Scattergories rules (ADR-0018, section 4 and the 2026-11-25 amendment, part C).
Pure: no I/O, no clock.

Randomness is injected as a `random.Random`. Scoring is derived on read from the answers
and host verdicts and never stored, so a verdict change cannot leave a stale score.
"""

from __future__ import annotations

import random
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

# ADR-0018: Q, U, V, X, Y and Z are never drawn.
EXCLUDED_LETTERS = frozenset("QUVXYZ")
LETTERS: tuple[str, ...] = tuple(
    c for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if c not in EXCLUDED_LETTERS
)
ARTICLES = frozenset({"a", "an", "the"})
REJECTED = "rejected"
ACCEPTED = "accepted"
SHORT_LETTERS = 3  # a valid answer with fewer letters than this goes to the host
TYPO_MIN_KEY = 6  # keys this long or longer are compared for a one-character typo

Answer = tuple[str, int, str]  # (person_id, category_index, text)
Verdicts = Mapping[tuple[str, int], str | None]  # (person_id, category_index) -> verdict
AnswerKey = tuple[str, int]  # (person_id, category_index)


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


def _fold_word(word: str) -> str:
    """One plural fold; `dedupe_key` repeats it until the word stops changing."""
    if len(word) >= 5 and word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith("es") and (
        word[:-2].endswith(("s", "x", "z", "ch", "sh")) or (len(word) >= 6 and word.endswith("oes"))
    ):
        # "oes" (potatoes, tomatoes) is a deliberate addition to the ADR's list: without it the
        # ADR's own example, "potatoes" against "potato", would not merge.
        return word[:-2]
    if len(word) >= 4 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    return word


def _fold(word: str) -> str:
    while (folded := _fold_word(word)) != word:
        word = folded
    return word


def dedupe_key(text: str) -> str:
    """`normalize`, then every word folded to its singular, so "mashed potatoes", "mashed
    potato" and "Mashed Potato!" share a key. Idempotent; a function of `normalize` only."""
    return " ".join(_fold(word) for word in normalize(text).split())


def matches_letter(answer: str, letter: str) -> bool:
    return normalize(answer).startswith(normalize(letter))


def is_valid(answer: str, letter: str, verdict: str | None) -> bool:
    """Starts with the round's letter after normalising, and not rejected by the host."""
    if verdict == REJECTED:
        return False
    return matches_letter(answer, letter)


def one_edit_apart(a: str, b: str) -> bool:
    """Levenshtein distance exactly 1 (one insert, delete or substitution)."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b, strict=True)) == 1
    short, long = (a, b) if len(a) < len(b) else (b, a)
    i = 0
    while i < len(short) and short[i] == long[i]:
        i += 1
    return short[i:] == long[i + 1 :]


def is_typo_pair(a: str, b: str) -> bool:
    """Two dedupe keys one character apart, both long enough to be worth flagging."""
    return len(a) >= TYPO_MIN_KEY and len(b) >= TYPO_MIN_KEY and one_edit_apart(a, b)


def _collide(
    strict_a: str, strict_b: str, loose_a: str, loose_b: str, accepted_a: bool, accepted_b: bool
) -> bool:
    """Do two valid answers in one category cancel each other? An exact (strict) match always
    does. Otherwise a plural-folded match does unless the host accepted either: *accept* means
    "this is its own answer"."""
    if strict_a == strict_b:
        return True
    return not (accepted_a or accepted_b) and loose_a == loose_b


def answer_points(
    answers: Sequence[Answer], verdicts: Verdicts, *, letter: str
) -> dict[tuple[str, int], int]:
    """(person_id, category_index) -> 1 for a valid answer that no other valid answer in its
    category collides with, else 0. Independent of answer and person order."""
    live: dict[int, list[tuple[str, str, str, bool]]] = {}
    for person_id, category_index, text in answers:
        verdict = verdicts.get((person_id, category_index))
        if is_valid(text, letter, verdict):
            live.setdefault(category_index, []).append(
                (person_id, normalize(text), dedupe_key(text), verdict == ACCEPTED)
            )
    points: dict[tuple[str, int], int] = {}
    for person_id, category_index, _ in answers:
        mine = next((e for e in live.get(category_index, ()) if e[0] == person_id), None)
        if mine is None:
            points[(person_id, category_index)] = 0
            continue
        clash = any(
            other[0] != person_id
            and _collide(mine[1], other[1], mine[2], other[2], mine[3], other[3])
            for other in live[category_index]
        )
        points[(person_id, category_index)] = int(not clash)
    return points


def score_round(answers: Sequence[Answer], verdicts: Verdicts, *, letter: str) -> dict[str, int]:
    """person_id -> points. A valid answer nobody else matches in its category is 1."""
    scores = {person_id: 0 for person_id, _, _ in answers}
    for (person_id, _), point in answer_points(answers, verdicts, letter=letter).items():
        scores[person_id] += point
    return scores


# ---- Host review ----

NEAR_DUPLICATE = "near_duplicate"
SHORT = "short"
DUPLICATE = "duplicate"
AUTO_REJECTED_LETTER = "auto_rejected_letter"
HOST_REJECTED = "host_rejected"
NEEDS_DECISION_KINDS = frozenset({NEAR_DUPLICATE, SHORT})


@dataclass(frozen=True)
class ReviewItem:
    kind: str
    category_index: int
    answers: tuple[AnswerKey, ...]  # sorted by person id


@dataclass(frozen=True)
class Review:
    needs_decision: tuple[ReviewItem, ...]
    informational: tuple[ReviewItem, ...]
    auto_accepted: tuple[AnswerKey, ...]


def _letter_count(text: str) -> int:
    return len(normalize(text).replace(" ", ""))


def _components(entries: list[tuple[str, str, str]]) -> list[list[str]]:
    """Groups (two or more) of person ids whose answers are near-duplicates: the same dedupe
    key but different strict text, or a typo pair. entries: (person_id, strict, loose)."""
    parent = {pid: pid for pid, _, _ in entries}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, (pa, sa, la) in enumerate(entries):
        for pb, sb, lb in entries[i + 1 :]:
            if (la == lb and sa != sb) or (la != lb and is_typo_pair(la, lb)):
                parent[find(pa)] = find(pb)
    groups: dict[str, list[str]] = {}
    for pid, _, _ in entries:
        groups.setdefault(find(pid), []).append(pid)
    return [sorted(g) for g in groups.values() if len(g) > 1]


def review(answers: Sequence[Answer], verdicts: Verdicts, *, letter: str) -> Review:
    """Partition every answer exactly once into what needs the host, what is only worth a
    glance, and what is simply accepted. A wrong letter is never offered for a decision."""
    needs: list[ReviewItem] = []
    info: list[ReviewItem] = []
    auto: list[AnswerKey] = []
    by_cat: dict[int, list[tuple[str, str]]] = {}
    for person_id, category_index, text in answers:
        by_cat.setdefault(category_index, []).append((person_id, text))

    for category_index in sorted(by_cat):
        wrong: list[str] = []
        rejected: list[str] = []
        short: list[str] = []
        live: list[tuple[str, str, str]] = []  # (person, strict, loose): valid, not rejected
        for person_id, text in sorted(by_cat[category_index]):
            verdict = verdicts.get((person_id, category_index))
            if not matches_letter(text, letter):
                wrong.append(person_id)
            elif _letter_count(text) < SHORT_LETTERS:
                short.append(person_id)
            elif verdict == REJECTED:
                rejected.append(person_id)
            else:
                live.append((person_id, normalize(text), dedupe_key(text)))

        def item(kind: str, people: list[str], cat: int = category_index) -> ReviewItem:
            return ReviewItem(kind, cat, tuple((p, cat) for p in sorted(people)))

        if wrong:
            info.append(item(AUTO_REJECTED_LETTER, wrong))
        if rejected:
            info.append(item(HOST_REJECTED, rejected))
        needs.extend(item(SHORT, [p]) for p in short)

        grouped: set[str] = set()
        for people in _components(live):
            needs.append(item(NEAR_DUPLICATE, people))
            grouped.update(people)
        by_strict: dict[str, list[str]] = {}
        for pid, strict, _ in live:
            if pid not in grouped:
                by_strict.setdefault(strict, []).append(pid)
        for strict in sorted(by_strict):
            people = by_strict[strict]
            if len(people) > 1:
                info.append(item(DUPLICATE, people))
            else:
                auto.append((people[0], category_index))

    def order(i: ReviewItem) -> tuple[int, str, AnswerKey]:
        return (i.category_index, i.kind, i.answers[0])

    return Review(
        tuple(sorted(needs, key=order)), tuple(sorted(info, key=order)), tuple(sorted(auto))
    )
