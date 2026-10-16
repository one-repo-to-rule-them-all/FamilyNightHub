# Runbook: Phase 1 acceptance

[`BUILD-PROMPT.md`](../architecture/BUILD-PROMPT.md) accepts Phase 1 on three things: a
Playwright run where 4 phones and a TV complete a night with photos, CI green, and one real family
night on production. CI proves the first two. Everything below "What CI does not prove" is owed by
hand before the first real family night.

## What CI proves

`frontend/e2e/acceptance.spec.ts`, in the `e2e` job (07-cicd.md), against the real API, Postgres,
Redis, MailHog and an S3 bucket (SeaweedFS), one journey through the real UI:

1. The host signs in on the TV's browser by the **emailed magic link** (MailHog) and pairs it as
   the TV. The TV waits, then follows the night once it exists.
2. The host signs in on their phone by a second emailed link, starts the night, types its code on
   the TV once, builds a 4-title shortlist (typed titles) and opens voting.
3. Four phones (two iPhone 13, two Pixel 7 profiles) open `/j/{slug}`, enter the code the TV shows
   and pick their avatars. One phone is shared by two people ("Pass to next person"). One phone asks
   for someone already on another phone; the host approves the claim on `/host`.
4. Everyone ranks posters; the host proxy-votes for a child without a phone. Each ballot lights its
   TV turnout tile **through the stream** (asserted within 4s, under one 5s poll, while every
   screen is `data-live="ready"`).
5. The host closes voting (pinned `X-FNH-Test-Seed`); the TV and all four phones show the same
   server-decided winner.
6. The reveal settles into `tonight` on its own (30s, no reload). Two phones add photos (the
   GPS-tagged JPEG and HEIC fixtures), a third sees both and reacts, the host hides one, and every
   phone stops showing it.
7. A browser that never joined receives no presigned photo URL from anything it can reach.
8. `/history` lists the night with its winner and turnout.
9. axe (WCAG 2.1 AA) on each distinct screen along the way.

Two steps call the API directly because Phase 1 has no UI for them (both arrive with Phase 2's
admin screens): adding people beyond the seeded three, and hiding a photo. The spec marks them
`API:`.

## What CI does not prove

Do these in order. Record the date and result of each in the release PR.

- [ ] **Fly provisioning, production.** Work through
      [`restore.md`](restore.md) section 0 (Postgres flavour, bucket names, deploy-token scope:
      owner decisions) and section 1 (apps, Postgres roles, Upstash Redis, Tigris buckets, secrets,
      GitHub environments, first deploy and first admin). Staging first, then production.
- [ ] **Tigris bucket CORS.** Phones PUT and GET the bucket cross-origin, so each deployed bucket
      needs a CORS rule for its web origin (04-frontend.md "Bucket CORS"). The Deploy workflow sets
      it with `deploy/bucket-cors.sh` and reads it back (07-cicd.md "Photos bucket CORS"), but only
      once the bucket-admin key and `PHOTOS_BUCKET` are on each GitHub environment
      ([`restore.md`](restore.md) §1.4, "CORS for phone uploads"); without them the step skips
      with a notice. Check: the Deploy run's CORS step ran (not skipped) for staging and
      production, and a photo added on staging uploads with no CORS error in the console. No
      browser preflight against Tigris runs in CI.
- [ ] **Real-iPhone HEIC checklist** on staging:
      [`photo-drop-iphone-checklist.md`](photo-drop-iphone-checklist.md). CI runs Chromium with an
      iPhone viewport; WebKit in Playwright is not iOS Safari, and the GPS strip on a real HEIC is a
      privacy property (ADR-0005).
- [ ] **Restore rehearsal** on staging: [`restore.md`](restore.md) section 2 (Postgres from a
      snapshot, photos from the backup bucket), then note the date under "Rehearsals" there.
- [ ] **One real family night on production.** Real phones on the home network, the real TV, the
      fridge QR. Afterwards: the night is in `/history`, its photos are in the album, and Sentry
      shows no new errors for the evening.
