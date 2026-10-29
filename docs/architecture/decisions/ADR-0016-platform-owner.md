# ADR-0016: Platform owner: a super-admin over every household, with guardrails

## Status

**Accepted 2026-10-28: option A, chosen by the owner** (issue #77). This overrides the original
recommendation (B), which is kept below for the record. Nothing is built yet. The build is issue
#77, and it adds the guardrails in "Decision" below. Multi-household still needs the consent ADR
that [ADR-0003](ADR-0003-household-scoping-app-plus-rls.md) and
[BUILD-PROMPT](../BUILD-PROMPT.md) call for before a **second** family is onboarded.

## Context

The owner wants `rbjengineeringservices.llc@gmail.com` to be the **platform owner** and to stay
the Baez Family **admin**. Today there is no such thing as a platform:

- One deployment serves exactly one household, created by `python -m app.cli bootstrap` over
  `fly ssh console`. Whoever can SSH into the API machine is, in practice, the operator.
- Every request is scoped to one household: the credential names it, `SET LOCAL
  app.household_id` binds it, FORCE RLS enforces it (ADR-0003). There is no code path that reads
  across households except the ADR-0009 definer functions, which return ids only, and the
  worker's `worker_list_household_ids()`.
- What the app holds is a family's private life: children's names and faces, photos, who voted
  for what, nights at home. A role that can read across families is the most dangerous thing this
  system could add.

So "platform owner" has to answer two questions: **what can it do**, and **what can it see**.

## Options

### A. Super-admin: a global role that can act as admin in every household

One flag on an account (or a new role) bypasses the household check, so the platform owner can
open any family's portal.

- ✅ Simplest to build: one permission check.
- ❌ Defeats ADR-0003: either RLS gets a bypass (a `BYPASSRLS` path or a policy exception), or the
  app switches the GUC to any household on request. One bug or one stolen session then reads
  every family's photos, ballots and children.
- ❌ It's the opposite of what a family would consent to. It can't be squared with a consent ADR.

### B. Operator over the deployment, content-blind (**recommended**)

A **platform** role, separate from household roles, that manages *households*, never their
*contents*:

- **Can:** create a household and assign its **first admin** (today's `bootstrap`, as an
  invite: the first admin gets the ADR-0015 invite email and chooses their own password); list
  households with **metadata only** (name, slug, created, admin emails, counts of people, devices,
  nights and photos, storage used, last activity); see **health and usage** (the `/api/health`
  data, worker job results, rate-limit hits, error rates); disable or re-enable a household
  (sign-ins and joins refused, nothing deleted); rotate a household's join slug on request.
- **Cannot:** read any family's people, photos, ballots, ratings, devices or audit-event
  details, or act as its admin. **Unless it is also that family's admin**, in which case it uses
  the ordinary household session like any admin. The owner's own account would hold both: platform
  owner, and Baez Family admin through its normal `accounts` row.
- **How it stays content-blind:** the platform API runs with **no household GUC at all**, so RLS
  returns nothing from any household table. Everything it needs comes through new
  ADR-0009-style `SECURITY DEFINER` functions owned by a dedicated role (e.g. `fnh_platform`) that
  return **aggregates and metadata only** (counts, sizes, timestamps, the admin emails it needs
  to assign). This is the same pattern as the existing six resolver functions, with the same
  rules: pinned `search_path`, column-level grants, `EXECUTE` for the app role only, and a test
  that pins the exact set.
- **Identity:** a separate table, `platform_operators (account_id, granted_at, granted_by)`,
  outside RLS, written only by a CLI command (`python -m app.cli grant-platform --email …`), never
  by the API. A platform session is a **separate cookie and sign-in step** (re-enter the
  password), so a stolen family-portal session is not a platform session. Every platform action
  writes a `platform_audit_events` row.
- **Surface:** a separate `/platform` area (not a tab in the family portal), so the two never
  share a screen or a query key.

- ✅ Keeps ADR-0003 intact: no RLS bypass, no GUC switching. A platform bug leaks counts, not
  photos.
- ✅ Matches what a family can consent to: "the operator knows you exist and how much storage you
  use; they can't see your photos."
- ❌ More to build: a definer-function set, a table, a second session type, a new area.
- ❌ Support cases ("my photo is missing") need the family's admin to look, or the family to grant
  access, not the operator. That is the intended cost.

### C. Status quo: keep the operator as "whoever has `fly ssh`"

No platform role in the app. New households are created with the CLI; health comes from Fly,
UptimeRobot and Sentry.

- ✅ Nothing to build, nothing new to secure. Correct for **one** household, which is today.
- ❌ Doesn't scale past a handful of households, and SSH access *is* full database access, which
  is a broader power than option B grants, just unlogged by the app.

## Recommendation

**Adopt B as the target, and stay on C until there is a second household.**

1. Now (no code): the owner is the operator via `fly ssh` and the CLI (C), and is the Baez Family
   admin through the ordinary account. ADR-0015 already covers adding the host.
2. Before any second household exists, write the **consent and multi-household ADR** (below) and
   get it approved. Option B is built only after that, because its first feature (create a
   household) *is* multi-household.
3. Build B as described: content-blind by construction (no GUC, metadata-only definer functions),
   a CLI-granted operator table, a separate session and area, and its own audit trail.

Option A is rejected outright.

## What the consent / multi-household ADR must decide first

Raised here so the owner sees the whole cost; **not decided by this ADR**:

- **Who is the customer**, and who consents for the children: the household's first admin, as a
  parent or guardian, with an explicit consent step and record before any child's profile or photo
  is stored (COPPA-style verifiable parental consent if the service is offered beyond the owner's
  own family).
- **Privacy policy and terms** the first admin accepts at sign-up, versioned.
- **Retention and deletion:** household export (the deferred zip export), and a household delete
  that removes rows *and* bucket objects and backups within a stated window.
- **Cross-household identity:** ADR-0015 keeps emails unique across households, which leaks
  "this address is in use" across families. Either accept that, or make accounts global with
  per-household memberships (a bigger change touching ADR-0014's login).
- **Billing and abuse** if strangers can sign up: none of this exists today.
- **The platform view's exact fields** (the metadata list in option B), each justified.

## Consequences of B (not chosen, kept for the record)

- New pre-auth surface: a platform definer-function set (metadata only) and `fnh_platform` role;
  `test_rls_coverage.py` grows to pin it.
- A second sign-in path and cookie. 03-backend.md "Auth & authorization" gains a third principal.
- `bootstrap` becomes "the operator invites a first admin", and the CLI remains for the very
  first operator.
- No change to any household's RLS, permissions or data.

## Decision (2026-10-28)

The owner chose **option A**. `rbjengineeringservices.llc@gmail.com` becomes the platform owner:
a global role that can open and act as admin in any household. It is also the Baez Family admin.

Option A carries the risks listed above: one bug or one stolen platform session reads every
family's photos, people and ballots. The owner accepted those risks. The build must keep them
as small as A allows:

1. **No RLS bypass.** The platform owner never gets `BYPASSRLS` and never gets a policy
   exception. The app enters one chosen household by setting `app.household_id` for that request
   only, and FORCE RLS still scopes every query to that one family. Nothing reads across
   households in one query.
2. **A separate, stronger sign-in.** The platform session uses its own cookie and a short idle
   timeout (for example 30 minutes). It requires a second factor (TOTP or a passkey) before it can
   enter a household. The family-admin login keeps working as it does today.
3. **Every entry is audited.** Entering a household writes an `audit_events` row in that
   household: actor, time and reason. The owner of that household sees it in the portal under
   History, or a new "Access log". Every write made while inside also carries the platform actor.
4. **Visible while inside.** A persistent banner reads "Viewing The {Family} as platform owner"
   and has an Exit button.
5. **Tests pin it.** Isolation tests prove a platform session sees only the household it
   entered. The RLS coverage test still passes with no bypass role. An entry without a second
   factor gets 403.
6. **Consent before a second family.** The consent / multi-household ADR (above) is written and
   accepted before any household other than the owner's own is created. Each new family's admin
   is told, in plain words, that the platform owner can view their family.

## Consequences

- A new principal (platform owner), a cookie and a second-factor step. 03-backend.md "Auth &
  authorization" gains a third principal.
- An "enter household" flow that sets the household per request, plus a platform screen that lists
  households (ids and names only, through a definer function, as ADR-0009 does).
- `bootstrap` stays as the first-operator path. The platform owner can also create a household
  and invite its first admin.
- No change to any household's RLS policies, and no bypass role.
