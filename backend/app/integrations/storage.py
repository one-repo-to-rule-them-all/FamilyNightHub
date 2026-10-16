"""Object storage seam (ADR-0005). Only the delete side exists so far.

The worker's `sweep_orphan_uploads` deletes the objects under an abandoned upload's keys
before it deletes the row. Until the photo pipeline lands there is no S3 client, so the
default store is a no-op; the pipeline PR replaces it with a Tigris/SeaweedFS-backed one and
tests inject a recording fake.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

import structlog

log = structlog.get_logger()


class ObjectStore(Protocol):
    async def delete_objects(self, keys: Sequence[str]) -> None:
        """Delete these keys. Missing keys are not an error (idempotent sweeps)."""
        ...


class NoopObjectStore:
    """Placeholder until the photo pipeline adds a real client. Logs the count, not the
    keys: keys embed household and session ids."""

    async def delete_objects(self, keys: Sequence[str]) -> None:
        log.info("storage_delete_skipped_noop_store", count=len(keys))
