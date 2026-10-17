"""ADR-0014 credential rules (pure) and the argon2id helpers."""

from __future__ import annotations

import uuid

import pytest

from app.core import hashing
from app.domain import credentials


@pytest.mark.parametrize("raw", ["Rodolfo", "  ana.b ", "kid_1", "a-b", "x" * 32])
def test_usernames_are_normalized_lowercase(raw: str) -> None:
    assert credentials.normalize_username(raw) == raw.strip().lower()


@pytest.mark.parametrize("raw", ["ab", "x" * 33, "me@home", "two words", "émile", ""])
def test_bad_usernames_are_refused(raw: str) -> None:
    with pytest.raises(ValueError, match="username"):
        credentials.normalize_username(raw)


def test_password_length_bounds() -> None:
    assert credentials.check_password("a sturdy phrase") == "a sturdy phrase"
    with pytest.raises(ValueError, match="at least 12"):
        credentials.check_password("short pass!")
    with pytest.raises(ValueError, match="at most 256"):
        credentials.check_password("x1" * 129)
    assert credentials.check_password("xy" * 128)  # exactly 256


@pytest.mark.parametrize("weak", ["password1234", "PASSWORD1234", "zzzzzzzzzzzzzz", "123456789012"])
def test_obvious_passwords_are_refused(weak: str) -> None:
    with pytest.raises(ValueError, match="too easy"):
        credentials.check_password(weak)


def test_password_may_not_be_the_username_or_email() -> None:
    with pytest.raises(ValueError, match="username or email"):
        credentials.check_password("Rodolfo.Baez.Jr", username="rodolfo.baez.jr")
    with pytest.raises(ValueError, match="username or email"):
        credentials.check_password("Me@Example.test", email="me@example.test")
    assert credentials.check_password("totally different", username="rodolfo", email=None)


@pytest.mark.parametrize(
    ("pin", "ok"),
    [
        ("000000", True),
        ("123456", True),
        ("12345", False),
        ("1234567", False),
        ("12a456", False),
        ("", False),
    ],
)
def test_pin_is_exactly_six_digits(pin: str, ok: bool) -> None:
    if ok:
        assert credentials.check_pin(pin) == pin
    else:
        with pytest.raises(ValueError, match="6 digits"):
            credentials.check_pin(pin)


def test_lock_threshold_is_five() -> None:
    assert [credentials.locks_after(n) for n in range(7)] == [False] * 5 + [True] * 2
    assert [credentials.attempts_left(n) for n in (0, 4, 5, 9)] == [5, 1, 0, 0]


async def test_password_hash_round_trip_and_dummy() -> None:
    stored = await hashing.hash_password("a sturdy phrase")
    assert stored.startswith("$argon2id$")
    assert "m=19456,t=2,p=1" in stored
    assert await hashing.verify_password(stored, "a sturdy phrase")
    assert not await hashing.verify_password(stored, "a sturdy phrasE")
    assert not await hashing.verify_password(None, "anything at all")
    assert not await hashing.verify_password("not-a-hash", "anything at all")
    assert not hashing.needs_rehash(stored)


async def test_pin_hash_is_peppered_and_bound_to_the_person() -> None:
    alice, bob = uuid.uuid4(), uuid.uuid4()
    stored = await hashing.hash_pin(alice, "123456")
    assert await hashing.verify_pin(stored, alice, "123456")
    assert not await hashing.verify_pin(stored, alice, "654321")
    # Copying Alice's hash onto Bob does not let Bob's claim use Alice's PIN.
    assert not await hashing.verify_pin(stored, bob, "123456")
