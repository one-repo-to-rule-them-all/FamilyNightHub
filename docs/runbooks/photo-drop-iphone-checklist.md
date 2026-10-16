# Runbook: real-iPhone photo drop checklist

**When:** before every release that touches photos (`frontend/src/lib/photos/`,
`frontend/src/components/photos/`, the photos API, or bucket config). CI can't cover this:
Playwright runs Chromium with an iPhone viewport, and WebKit in Playwright is not iOS Safari
([ADR-0005](../architecture/decisions/ADR-0005-photo-pipeline-and-storage.md),
[`07-cicd.md`](../architecture/07-cicd.md#what-ci-does-not-enforce)).

**Where:** staging (`fnh-web-staging`), on a real iPhone running the current iOS, in Safari. Use
synthetic photos only (02-environments.md): never production photos, and never photos of real
children taken for the test. A photo of an object with **Location Services on for the Camera** is
what you want.

**Record:** the iOS version, the date, and pass/fail per step in the release PR.

## Before you start

1. On the iPhone: Settings → Camera → Formats → **High Efficiency** (so the camera writes HEIC),
   and Settings → Privacy → Location Services → Camera → **While Using**.
2. Take two photos: one in portrait orientation, one landscape. Check in Photos → (i) that both show
   a location on the map. These are your GPS-tagged HEIC originals.
3. On staging, open a night that is `tonight` (host: open voting, close it, wait 30 s), and join
   it on the iPhone.

## Checklist

| # | Step | Pass when |
|---|---|---|
| 1 | Tap **Add photos** on `/s/<night>` | iOS offers Photo Library, Take Photo and Choose File (no camera-only sheet: the input has no `capture`) |
| 2 | Pick both HEIC photos from the library | Each gets a row: "Getting it ready…" → "Uploading…" with a moving bar → "Added" |
| 3 | Look at the album grid | Both thumbnails appear, the right way up (portrait stays portrait) |
| 4 | Open each photo full-screen | The image is sharp, upright, and shows your avatar and name |
| 5 | **GPS gone (the important one).** On a laptop, while the album is open on a phone of the same household, run `curl` on the photo's presigned `url` (from `GET /api/v1/sessions/<id>/photos` in that phone's devtools/network, or from a desktop browser joined to the same night) and inspect it with `exiftool photo.jpg` | No GPS tags, no EXIF block at all (`exiftool` shows only JFIF/file fields); width or height is 2048 at most |
| 6 | Take a new photo with **Take Photo** from the picker | It uploads like the library ones |
| 7 | Lock the phone during an upload of 5+ photos, unlock after ~30 s | The queue carries on; every row ends at "Added" with no duplicates in the album |
| 8 | Airplane mode on, add a photo, wait for "Connection hiccup, trying again…", airplane mode off | The photo finishes uploading once the phone is back online |
| 9 | Close Safari during an upload, reopen `/s/<night>` | Leftover uploads resume and finish (IndexedDB queue) |
| 10 | React with ❤️ on a photo; check it from a second phone | The count shows on both; only the first phone shows it pressed |
| 11 | Wait 12+ minutes on the album with the phone locked, then unlock | Thumbnails still load (expired presigned URLs are replaced, not shown broken) |

## If a step fails

- **2 or 3 fails for HEIC only:** Safari's `createImageBitmap` couldn't decode it and the `heic-to`
  fallback failed too. Check the console for a `heic-to` worker error; a CSP that blocks `blob:`
  workers or `wasm-unsafe-eval` would do it.
- **5 fails:** stop the release. The GPS strip is a privacy property (ADR-0005); the bucket copy
  must be deleted (admin hard delete) and the pipeline fixed first.
- **PUTs fail with a CORS error in the console:** the bucket's CORS rule doesn't list the web
  origin (Tigris bucket config for `fnh-web-staging` / prod; locally and in CI
  `frontend/e2e/setup_bucket.py` sets it).
