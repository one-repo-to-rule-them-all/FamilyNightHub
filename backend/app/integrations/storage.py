"""The private photos bucket over the S3 API (ADR-0005, 05-data.md "Object storage").

S3 calls and presigning only; the rules (who may upload, what counts as a valid object)
live in app/services/photo_service.py. Photo bytes never pass through the API: phones PUT
to a presigned URL and fetch through presigned GETs, both minted here.

boto3 rather than aioboto3: presigning is local CPU work (no I/O, so no thread needed),
and the only network calls are a HEAD per object on `complete` and a DELETE per object on
a hard delete, which run on a worker thread via `asyncio.to_thread`. aioboto3 would pin
aiobotocore's botocore range and add a dependency for those few calls.

Services depend on the `PhotoStorage` protocol, never on boto3, so tests swap in an
in-memory fake through the `photo_storage` FastAPI dependency. The worker depends only on
the narrower `ObjectStore` (bulk delete for `sweep_orphan_uploads`); `S3PhotoStorage`
implements both, and `NoopObjectStore` stands in when storage is not configured.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from functools import cache
from typing import Any, Protocol

import boto3
import structlog
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.core.config import settings

JPEG = "image/jpeg"
# ADR-0005: uploads get 5 minutes, views 10.
PUT_TTL_SECONDS = 300
GET_TTL_SECONDS = 600


log = structlog.get_logger()


class StorageUnavailable(Exception):
    """The bucket is unreachable or answered with an error other than "no such key"."""


@dataclass(frozen=True)
class ObjectInfo:
    size: int
    content_type: str | None


class PhotoStorage(Protocol):
    def presign_put(self, key: str) -> str:
        """A URL that accepts one PUT of `key` with `Content-Type: image/jpeg`."""
        ...

    def presign_get(self, key: str) -> str: ...

    async def head(self, key: str) -> ObjectInfo | None:
        """Size and type of `key`, or None if it does not exist."""
        ...

    async def delete(self, key: str) -> None:
        """Idempotent: deleting a missing key succeeds."""
        ...


class ObjectStore(Protocol):
    async def delete_objects(self, keys: Sequence[str]) -> None:
        """Delete these keys. Missing keys are not an error (idempotent sweeps)."""
        ...


class NoopObjectStore:
    """Used by the worker when storage is not configured. Logs the count, not the keys:
    keys embed household and session ids."""

    async def delete_objects(self, keys: Sequence[str]) -> None:
        log.info("storage_delete_skipped_noop_store", count=len(keys))


def _client(endpoint: str, access_key: str, secret_key: str, region: str) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        # Path-style works on both Tigris and SeaweedFS and keeps the bucket out of DNS.
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
            connect_timeout=5,
            read_timeout=10,
        ),
    )


class S3PhotoStorage:
    def __init__(
        self,
        *,
        endpoint: str,
        bucket: str,
        access_key: str,
        secret_key: str,
        region: str,
        public_endpoint: str | None = None,
    ) -> None:
        self.bucket = bucket
        self._s3 = _client(endpoint, access_key, secret_key, region)
        self._signer = (
            _client(public_endpoint, access_key, secret_key, region)
            if public_endpoint and public_endpoint != endpoint
            else self._s3
        )

    def presign_put(self, key: str) -> str:
        # ContentType is part of the signature: a PUT with any other type is refused by
        # the bucket. A presigned PUT cannot cap the size, hence the HEAD on complete.
        url: str = self._signer.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": JPEG},
            ExpiresIn=PUT_TTL_SECONDS,
        )
        return url

    def presign_get(self, key: str) -> str:
        url: str = self._signer.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=GET_TTL_SECONDS,
        )
        return url

    async def head(self, key: str) -> ObjectInfo | None:
        try:
            resp = await asyncio.to_thread(self._s3.head_object, Bucket=self.bucket, Key=key)
        except ClientError as err:
            code = str(err.response.get("Error", {}).get("Code", ""))
            if code in ("404", "NoSuchKey", "NotFound"):
                return None
            raise StorageUnavailable(code) from err
        except BotoCoreError as err:
            raise StorageUnavailable(type(err).__name__) from err
        return ObjectInfo(size=int(resp["ContentLength"]), content_type=resp.get("ContentType"))

    async def delete(self, key: str) -> None:
        try:
            await asyncio.to_thread(self._s3.delete_object, Bucket=self.bucket, Key=key)
        except (ClientError, BotoCoreError) as err:
            raise StorageUnavailable(type(err).__name__) from err

    async def delete_objects(self, keys: Sequence[str]) -> None:
        for key in keys:
            await self.delete(key)


@cache
def configured_storage() -> S3PhotoStorage | None:
    """The photos bucket from settings, or None when storage is not configured. Built once:
    boto3 clients are thread-safe and expensive to create."""
    if not (
        settings.STORAGE_ENDPOINT
        and settings.STORAGE_ACCESS_KEY_ID
        and settings.STORAGE_SECRET_ACCESS_KEY
    ):
        return None
    return S3PhotoStorage(
        endpoint=settings.STORAGE_ENDPOINT,
        bucket=settings.STORAGE_BUCKET,
        access_key=settings.STORAGE_ACCESS_KEY_ID,
        secret_key=settings.STORAGE_SECRET_ACCESS_KEY,
        region=settings.STORAGE_REGION,
        public_endpoint=settings.STORAGE_PUBLIC_ENDPOINT,
    )
