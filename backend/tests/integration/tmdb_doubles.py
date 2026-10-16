"""TMDB doubles for integration tests: the tmdb-fake app in-process, a TMDB that is down,
and no TMDB at all. CI never reaches the real API."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import httpx

from app.api.v1.tmdb import tmdb_client
from app.integrations.tmdb import TmdbClient
from app.main import app
from tmdb_fake.app import app as fake_app


def fake_client() -> TmdbClient:
    return TmdbClient("http://tmdb-fake", "test-token", transport=httpx.ASGITransport(fake_app))


def _refuse(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("TMDB is down", request=request)


def down_client() -> TmdbClient:
    return TmdbClient("http://tmdb-down", "test-token", transport=httpx.MockTransport(_refuse))


@contextmanager
def tmdb(client: TmdbClient | None) -> Iterator[None]:
    """Route the API's TMDB dependency to `client` (None = TMDB not configured)."""
    app.dependency_overrides[tmdb_client] = lambda: client
    try:
        yield
    finally:
        app.dependency_overrides.pop(tmdb_client, None)
