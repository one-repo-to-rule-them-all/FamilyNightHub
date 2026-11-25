"""Gratitude Jar rules (ADR-0018): the reveal order and the note rules. Pure, no I/O.

The order is a seeded shuffle over the note ids in sorted order, so neither insertion order
nor read order can change it, and a test can pin it with the seed (like the voting
tie-break, ADR-0006).
"""

from __future__ import annotations

import random
import re
import unicodedata
import uuid
from collections.abc import Iterable

MAX_NOTE_LENGTH = 280


def clean_body(raw: str) -> str:
    """Whitespace collapsed and trimmed. May come back empty; the caller refuses that."""
    return " ".join(raw.split())


def reveal_order(note_ids: Iterable[uuid.UUID], seed: int) -> list[uuid.UUID]:
    """The notes in the order the host will show them."""
    ordered = sorted(note_ids)
    random.Random(seed).shuffle(ordered)
    return ordered


# ---- Auto-cycle (ADR-0018 amendment, part B) ----

CYCLE_SECONDS_MIN = 5
CYCLE_SECONDS_MAX = 60
CYCLE_SECONDS_DEFAULT = 12
GROUP_CAP = 6

_STOPWORDS = frozenset(
    """
    a an the and or but nor so yet of to in on at by for from with about into over as if
    i me my mine we us our ours you your yours he him his she her hers it its they them their
    theirs this that these those who whom what which is am are was were be been being have has
    had do does did very really just also too more most much many some any all each every
    thankful grateful thanks thank appreciate appreciated appreciating gratitude glad
    so than then there here when while will would can could should not no
    """.split()
)


def can_pause(paused_index: int | None) -> bool:
    return paused_index is None


def can_resume(paused_index: int | None) -> bool:
    return paused_index is not None


def cycle_index(
    now: float, anchor_at: float, dwell_seconds: float, count: int, paused_index: int | None
) -> int:
    """The index on show. Times are seconds (any common epoch). Before the anchor (clock
    skew) it is the first note; a paused jar shows its held index, clamped to the list."""
    if count <= 0:
        return 0
    if paused_index is not None:
        return min(paused_index, count - 1)
    elapsed = max(0.0, now - anchor_at)
    return int(elapsed // dwell_seconds) % count


def _fold(word: str) -> str:
    if len(word) >= 5:
        if word.endswith("ies"):
            return word[:-3] + "y"
        for suffix in ("ing", "ed", "es"):
            if word.endswith(suffix):
                return word[: -len(suffix)]
        if word.endswith("s") and not word.endswith("ss"):
            return word[:-1]
    return word


def keywords(body: str) -> frozenset[str]:
    """Casefolded, accent- and punctuation-free content words, lightly stemmed."""
    plain = unicodedata.normalize("NFKD", body.casefold())
    plain = "".join(c for c in plain if not unicodedata.combining(c))
    words = re.sub(r"[^a-z0-9\s]", " ", plain.replace("'", "")).split()
    return frozenset(stem for w in words if w not in _STOPWORDS and len(stem := _fold(w)) >= 3)


def similar(a: frozenset[str], b: frozenset[str]) -> bool:
    if not a or not b:
        return False
    shared = len(a & b)
    return shared >= 2 or shared / len(a | b) >= 0.5


def group_order(notes: Iterable[tuple[uuid.UUID, str]], seed: int) -> list[uuid.UUID]:
    """Every note id, similar notes next to each other. Deterministic per seed and
    independent of input order; connected components capped at GROUP_CAP."""
    ordered = sorted(notes, key=lambda n: n[0])
    kw = {nid: keywords(body) for nid, body in ordered}
    ids = [nid for nid, _ in ordered]
    parent = {i: i for i in ids}

    def find(x: uuid.UUID) -> uuid.UUID:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for pos, a in enumerate(ids):
        for b in ids[pos + 1 :]:
            if similar(kw[a], kw[b]):
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[max(ra, rb)] = min(ra, rb)
    components: dict[uuid.UUID, list[uuid.UUID]] = {}
    for i in ids:
        components.setdefault(find(i), []).append(i)
    groups = [
        members[k : k + GROUP_CAP]
        for members in components.values()
        for k in range(0, len(members), GROUP_CAP)
    ]
    groups.sort(key=min)
    rng = random.Random(seed)
    for g in groups:
        rng.shuffle(g)
    rng.shuffle(groups)
    return [i for g in groups for i in g]
