"""App factory behaviour that needs no data plane: request ids, error envelope, health 503."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.v1 import health
from app.main import app


@pytest.fixture
async def client() -> AsyncClient:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_request_id_is_generated_and_echoed(client: AsyncClient) -> None:
    generated = await client.get("/api/v1/nope")
    assert generated.headers["x-request-id"]

    echoed = await client.get("/api/v1/nope", headers={"X-Request-ID": "abc-123"})
    assert echoed.headers["x-request-id"] == "abc-123"


async def test_unknown_route_uses_error_envelope(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/nope", headers={"X-Request-ID": "rid-1"})
    assert resp.status_code == 404
    assert resp.json() == {
        "error": {"code": "http_error", "message": "Not Found", "request_id": "rid-1"}
    }


@pytest.mark.parametrize(
    ("database", "redis", "expected_status"),
    [("ok", "ok", 200), ("error", "ok", 503), ("ok", "error", 503)],
)
async def test_health_reports_each_dependency(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    database: str,
    redis: str,
    expected_status: int,
) -> None:
    async def fake_db() -> str:
        return database

    async def fake_redis() -> str:
        return redis

    monkeypatch.setattr(health, "_check_database", fake_db)
    monkeypatch.setattr(health, "_check_redis", fake_redis)

    resp = await client.get("/api/health")
    assert resp.status_code == expected_status
    body = resp.json()
    assert body["database"] == database
    assert body["redis"] == redis
    assert body["status"] == ("ok" if expected_status == 200 else "error")
