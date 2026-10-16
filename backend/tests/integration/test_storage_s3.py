"""The real S3 client against a real S3 API (the SeaweedFS compose service locally).

Skipped unless STORAGE_TEST_ENDPOINT is set: CI has no S3 service container yet. Locally:
    STORAGE_TEST_ENDPOINT=http://localhost:58333 STORAGE_TEST_ACCESS_KEY_ID=fnh-dev-access \
    STORAGE_TEST_SECRET_ACCESS_KEY=fnh-dev-secret uv run pytest tests/integration/test_storage_s3.py
Uses its own bucket (STORAGE_TEST_BUCKET) and a random key prefix, and deletes what it writes.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import httpx
import pytest

from app.integrations.storage import S3PhotoStorage

ENDPOINT = os.environ.get("STORAGE_TEST_ENDPOINT")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.s3,
    pytest.mark.skipif(not ENDPOINT, reason="STORAGE_TEST_ENDPOINT not set (no S3 service)"),
]


@pytest.fixture(scope="module")
def s3() -> Iterator[S3PhotoStorage]:
    assert ENDPOINT
    store = S3PhotoStorage(
        endpoint=ENDPOINT,
        bucket=os.environ.get("STORAGE_TEST_BUCKET", "fnh-photos-test"),
        access_key=os.environ.get("STORAGE_TEST_ACCESS_KEY_ID", "fnh-dev-access"),
        secret_key=os.environ.get("STORAGE_TEST_SECRET_ACCESS_KEY", "fnh-dev-secret"),
        region="us-east-1",
    )
    client = store._s3
    try:
        client.create_bucket(Bucket=store.bucket)
    except client.exceptions.BucketAlreadyOwnedByYou:
        pass
    except client.exceptions.BucketAlreadyExists:
        pass
    yield store


async def test_presigned_put_head_get_delete_roundtrip(s3: S3PhotoStorage) -> None:
    key = f"test/{uuid.uuid4()}.jpg"
    body = b"\xff\xd8\xff\xe0" + b"x" * 2048
    async with httpx.AsyncClient() as http:
        put = await http.put(
            s3.presign_put(key), content=body, headers={"Content-Type": "image/jpeg"}
        )
        assert put.status_code == 200, put.text

        info = await s3.head(key)
        assert info is not None
        assert info.size == len(body)
        assert info.content_type == "image/jpeg"

        got = await http.get(s3.presign_get(key))
        assert got.status_code == 200
        assert got.content == body

        # The bucket is private: the bare object URL is refused.
        bare = await http.get(f"{ENDPOINT}/{s3.bucket}/{key}")
        assert bare.status_code in (401, 403)

    await s3.delete(key)
    assert await s3.head(key) is None
    await s3.delete(key)  # idempotent


async def test_presigned_put_pins_the_content_type(s3: S3PhotoStorage) -> None:
    key = f"test/{uuid.uuid4()}.jpg"
    async with httpx.AsyncClient() as http:
        put = await http.put(
            s3.presign_put(key), content=b"<svg/>", headers={"Content-Type": "image/svg+xml"}
        )
    assert put.status_code == 403
    assert await s3.head(key) is None
