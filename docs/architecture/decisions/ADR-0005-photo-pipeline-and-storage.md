# ADR-0005: Photos are processed on the phone, uploaded direct to private Tigris, and backed up nightly

## Status

Accepted (2026-10-15). Photo drop ships in Phase 1 by owner decision.

## Context

Photos are of children: they must never be publicly listable, must not leak GPS, and are
irreplaceable. Current iPhones (Safari 26.4/27) upload **raw HEIC** and may include location.
Chrome/Firefox can't decode HEIC natively. Proxying uploads through the API wastes bandwidth and
memory on small Fly machines. Object storage is never covered by Postgres backups.

## Decision

- **On the phone** (`frontend/src/lib/photos/`), one file at a time: read `DateTimeOriginal` with
  `exifr` (date only), decode via `createImageBitmap`; if that fails, lazy-load the `heic-to` WASM
  decoder in a Web Worker. Re-encode through canvas to a **2048px JPEG q≈0.82** (~400–700 KB) plus a
  **480px thumbnail**. Re-encoding drops all EXIF including GPS.
- **Upload**: `POST /api/v1/sessions/{id}/photos` creates a `photos` row (`status=pending`) and
  returns presigned PUT URLs (5 min) for `households/{hid}/sessions/{sid}/{photo_id}.jpg` and
  `…_thumb.jpg`. The phone PUTs directly to Tigris from an IndexedDB-backed queue with retry, then
  calls `…/complete`. The API verifies object size and type (`image/jpeg`, ≤10 MB) with a HEAD.
- **Viewing**: the bucket is private; album endpoints return presigned GETs (10 min TTL), minted per
  request after the household check. No "copy link" UI.
- **Moderation**: hide (soft) and delete (hard: DB row + both objects + backup copy within 24h).
- **Backup**: the worker copies new objects nightly to a separate `fnh-photos-backup` bucket with
  credentials the API never holds ([`06-background-worker.md`](../06-background-worker.md)).

## Alternatives considered

**Server-side processing (Pillow in the worker).** Rejected for v1: it means uploading 3–5 MB
originals over home Wi-Fi and storing GPS-laden originals, even briefly. Revisit if client decode
proves unreliable.

**Keep originals.** Rejected for v1 (storage and privacy). Families keep originals on their phones.

**Public bucket with unguessable names.** Rejected: names leak via history and screenshots.

## Consequences

- GPS stripping is a tested property: a unit test runs a GPS-tagged HEIC/JPEG fixture through the
  pipeline and asserts with `exifr` that no GPS IFD remains. A Playwright test uploads the fixture.
- **Real-iPhone smoke test** is a manual release checklist item (WebKit in Playwright ≠ iOS Safari).
- Pending rows older than 24h are swept by the worker (orphan cleanup).
- Budget: ~30 photos/night × ~0.6 MB ≈ 18 MB/night, roughly 1 GB/year. Trivial on Tigris.
- See [`04-frontend.md`](../04-frontend.md) "Photo drop", [`05-data.md`](../05-data.md) "Object storage".
