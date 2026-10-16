"""Photo storage doubles: an in-memory bucket, and one that is down. The real S3 client is
exercised against SeaweedFS in test_storage_s3.py (skipped when no S3 is configured)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from urllib.parse import quote

from app.api.v1.photos import photo_storage
from app.integrations.storage import ObjectInfo, PhotoStorage, StorageUnavailable
from app.main import app

FAKE_HOST = "https://bucket.fake"


class FakeStorage:
    """Objects live in a dict. Presigned URLs carry the key so tests can assert on it."""

    def __init__(self) -> None:
        self.objects: dict[str, ObjectInfo] = {}
        self.deleted: list[str] = []

    def put(self, key: str, size: int = 500_000, content_type: str | None = "image/jpeg") -> None:
        """What the phone's presigned PUT would have done."""
        self.objects[key] = ObjectInfo(size=size, content_type=content_type)

    def presign_put(self, key: str) -> str:
        return f"{FAKE_HOST}/{quote(key)}?op=put&X-Amz-Expires=300"

    def presign_get(self, key: str) -> str:
        return f"{FAKE_HOST}/{quote(key)}?op=get&X-Amz-Expires=600"

    async def head(self, key: str) -> ObjectInfo | None:
        return self.objects.get(key)

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)
        self.deleted.append(key)


class DownStorage(FakeStorage):
    async def head(self, key: str) -> ObjectInfo | None:
        raise StorageUnavailable("down")

    async def delete(self, key: str) -> None:
        raise StorageUnavailable("down")


@contextmanager
def storage(fake: PhotoStorage | None) -> Iterator[None]:
    """Route the API's photo storage dependency to `fake` (None = not configured)."""
    app.dependency_overrides[photo_storage] = lambda: fake
    try:
        yield
    finally:
        app.dependency_overrides.pop(photo_storage, None)
