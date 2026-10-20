from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError

from app.core import security
from app.core.config import Settings


def test_tokens_are_256_bit_and_unique() -> None:
    tokens = {security.new_token() for _ in range(50)}
    assert len(tokens) == 50
    assert all(len(t) == 43 for t in tokens)


def test_hashes_are_domain_separated_and_household_bound() -> None:
    hid_a, hid_b = uuid.uuid4(), uuid.uuid4()
    assert security.hash_device_token("ABC234") != security.hash_night_code("ABC234", hid_a)
    assert security.hash_night_code("ABC234", hid_a) != security.hash_night_code("ABC234", hid_b)
    assert security.hash_night_code("ABC234", hid_a) == security.hash_night_code("ABC234", hid_a)
    assert len(security.hash_device_token("x")) == 64


@pytest.mark.parametrize(
    ("cookie", "header", "ok"),
    [("abc", "abc", True), ("abc", "abd", False), (None, "abc", False), ("abc", None, False)],
)
def test_csrf_matches(cookie: str | None, header: str | None, ok: bool) -> None:
    assert security.csrf_matches(cookie, header) is ok


@pytest.mark.parametrize("env", ["staging", "production"])
def test_deployed_environments_refuse_placeholder_secrets(env: str) -> None:
    with pytest.raises(ValidationError, match="placeholder secrets"):
        Settings(ENVIRONMENT=env)  # type: ignore[arg-type]
    with pytest.raises(ValidationError, match="PLATFORM_SESSION_SECRET"):
        Settings(ENVIRONMENT=env, SESSION_SECRET="real", DEVICE_TOKEN_PEPPER="real")  # type: ignore[arg-type]
    Settings(
        ENVIRONMENT=env,  # type: ignore[arg-type]
        SESSION_SECRET="real",
        DEVICE_TOKEN_PEPPER="real",
        PLATFORM_SESSION_SECRET="real",
    )


def test_development_allows_placeholders() -> None:
    Settings(ENVIRONMENT="development")
