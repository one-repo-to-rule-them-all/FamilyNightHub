"""The S3 photo storage client without an S3 service: configuration, presigning, outages."""

from __future__ import annotations

from typing import get_args
from urllib.parse import parse_qs, urlsplit

import pytest

from app.core.config import settings
from app.integrations import storage
from app.integrations.storage import S3PhotoStorage, StorageUnavailable, configured_storage
from app.schemas.photos import Reaction
from app.services import photo_service


def _store(endpoint: str = "http://127.0.0.1:1", **kw: str) -> S3PhotoStorage:
    return S3PhotoStorage(
        endpoint=endpoint,
        bucket="fnh-photos",
        access_key="AKIATEST",
        secret_key="secret",
        region="auto",
        **kw,
    )


def test_presigned_put_is_short_lived_and_pins_jpeg() -> None:
    url = urlsplit(_store().presign_put("households/h/sessions/s/p.jpg"))
    q = parse_qs(url.query)
    assert url.path == "/fnh-photos/households/h/sessions/s/p.jpg"
    assert q["X-Amz-Expires"] == ["300"]
    assert "content-type" in q["X-Amz-SignedHeaders"][0]


def test_presigned_get_lasts_ten_minutes() -> None:
    q = parse_qs(urlsplit(_store().presign_get("k.jpg")).query)
    assert q["X-Amz-Expires"] == ["600"]


def test_presigned_urls_use_the_public_endpoint() -> None:
    store = _store("http://s3:8333", public_endpoint="http://localhost:58333")
    assert store.presign_get("k.jpg").startswith("http://localhost:58333/fnh-photos/k.jpg?")
    assert _store("http://s3:8333").presign_get("k.jpg").startswith("http://s3:8333/")


async def test_unreachable_bucket_is_storage_unavailable() -> None:
    store = _store()
    with pytest.raises(StorageUnavailable):
        await store.head("k.jpg")
    with pytest.raises(StorageUnavailable):
        await store.delete("k.jpg")


async def test_client_errors_other_than_missing_are_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from botocore.exceptions import ClientError

    store = _store()

    def denied(**_: object) -> None:
        raise ClientError({"Error": {"Code": "403"}}, "HeadObject")

    def missing(**_: object) -> None:
        raise ClientError({"Error": {"Code": "404"}}, "HeadObject")

    monkeypatch.setattr(store._s3, "head_object", missing)
    assert await store.head("k.jpg") is None
    monkeypatch.setattr(store._s3, "head_object", denied)
    with pytest.raises(StorageUnavailable):
        await store.head("k.jpg")
    monkeypatch.setattr(store._s3, "delete_object", denied)
    with pytest.raises(StorageUnavailable):
        await store.delete("k.jpg")


def test_configured_storage_needs_endpoint_and_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    configured_storage.cache_clear()
    monkeypatch.setattr(settings, "STORAGE_ENDPOINT", None)
    assert configured_storage() is None
    configured_storage.cache_clear()
    monkeypatch.setattr(settings, "STORAGE_ENDPOINT", "http://localhost:58333")
    monkeypatch.setattr(settings, "STORAGE_ACCESS_KEY_ID", "id")
    monkeypatch.setattr(settings, "STORAGE_SECRET_ACCESS_KEY", "secret")
    built = configured_storage()
    assert isinstance(built, storage.S3PhotoStorage)
    assert built.bucket == settings.STORAGE_BUCKET
    configured_storage.cache_clear()


def test_reaction_schema_matches_the_service_allowlist() -> None:
    assert get_args(Reaction) == photo_service.REACTIONS


async def test_delete_objects_deletes_each_key(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _store()
    deleted: list[str] = []

    def record(**kw: str) -> None:
        deleted.append(kw["Key"])

    monkeypatch.setattr(store._s3, "delete_object", record)
    await store.delete_objects(["a.jpg", "a_thumb.jpg"])
    assert deleted == ["a.jpg", "a_thumb.jpg"]


async def test_noop_store_deletes_nothing() -> None:
    await storage.NoopObjectStore().delete_objects(["a.jpg"])
