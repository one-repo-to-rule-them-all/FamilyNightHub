# ADR-0016: Platform owner: a super-admin who enters one household at a time, never bypassing RLS

## Status

**Accepted (owner decision 2026-10-19, issue #77): option A**, designed after the super user in qrMemorial's ADR-0006 (separate private repo
`one-repo-to-rule-them-all/qrMemorial`,
`docs/architecture/decisions/ADR-0006-family-admin-and-super-user-role-model.md`). Amends [ADR-0003](ADR-0003-household-scoping-app-plus-rls.md) (a third credential can
bind the household) and [ADR-0009](ADR-0009-pre-auth-lookups-via-definer-functions.md) (one more
definer function and role).

**Sequencing:** built after the consent and multi-household ADR,
[ADR-0017](ADR-0017-consent-and-multi-household.md) (accepted 2026-10-19), and its prerequisites. The
platform owner's first feature, creating a household, *is* multi-household, and a family has to be
told that the operator can open its household before the operator can.

The earlier draft of this ADR recommended option B (a content-blind operator). The owner chose A.
Both options and the trade-off are kept below so the reasoning stays on record.

## Context

The owner wants `rbjengineeringservices.llc@gmail.com` to be the **platform owner** and to stay
the Baez Family **admin**. Today there is no platform:

- One deployment serves exactly one household, created by `python -m app.cli bootstrap` over
  `fly ssh console`. Whoever can SSH into the API machine is, in practice, the operator.
- Every request is scoped to one household: the credential names it, `SET LOCAL
  app.household_id` binds it, FORCE RLS enforces it (ADR-0003). Nothing reads across households
  except the ADR-0009 definer functions (ids only) and the worker's `worker_list_household_ids()`.
- What the app holds is a family's private life: children's names and faces, photos, ballots,
  nights at home.

qrMemorial answered the same question with a super user: a flag granted outside the app, an
explicit `{ superUser: true }` scope on every repository call (never an implicit unfiltered
default), and a visually separate surface. The owner wants the same capability here: to support
any family directly, without asking that family's admin to look.

The difference that shapes the design: qrMemorial scopes in application code, so a super user is
one more argument. FamilyNight scopes in **Postgres** (FORCE RLS, no `BYPASSRLS` anywhere). A
super user here must work *with* RLS, not around it.

## Decision

A **platform operator** can act as an admin in any household, **one household at a time**, by
explicitly entering it. RLS is never bypassed. The household comes from a signed server-side
session, never a request parameter, exactly as ADR-0003 requires.

1. **Who.** A table `platform_operators (account_id PK → accounts.id, granted_at, granted_by)`.
   It holds no household data, so no RLS; `fnh_app` has `SELECT` only. Rows are written **only**
   by the CLI (`python -m app.cli grant-platform --email …` / `revoke-platform --email …`) over
   `fly ssh`, never by the API. This is qrMemorial's "rare, auditable, platform-operator action":
   "who has platform power" is one query.
2. **A separate sign-in.** `POST /api/v1/platform/login {email, password}` asks for the password
   again even when a family-portal session exists, so a stolen `fnh_session` is never a platform
   session. It issues a separate cookie, `fnh_platform`, signed with its own
   `PLATFORM_SESSION_SECRET`, `HttpOnly; Secure; SameSite=Strict`, **4 hours** absolute
   (`PLATFORM_SESSION_HOURS`). Failures share the ADR-0014 login budgets. Each request re-reads
   both the account and the `platform_operators` row, so `revoke-platform` or disabling the
   account takes effect on the next request.
3. **The household list.** `GET /api/v1/platform/households` runs with **no household GUC** and
   reads through one new ADR-0009-style definer function, `platform_list_households()`, owned by
   a new `NOLOGIN` role `fnh_platform` with column-level grants. It returns metadata only: id,
   name, created, disabled, counts of people, devices, nights and photos, and last activity. It
   has the same rules as the resolvers: pinned `search_path`, `STABLE`, `EXECUTE` for `fnh_app`
   only, and pinned by `test_rls_coverage.py`. This listing is the only cross-household read.
4. **Entering a household.** `POST /api/v1/platform/households/{id}/enter` re-checks the operator
   row, writes the audit rows (6), and re-signs `fnh_platform` bound to that household
   (`{account}.{household}.{issued_at}`). From then on, the ordinary admin endpoints accept that
   cookie: the household is taken from the signature, `SET LOCAL app.household_id` binds it, and
   RLS returns that household and nothing else. Entering another household replaces the binding.
   `POST /api/v1/platform/exit` drops it. The cookie never names two households, and there is no
   "all households" mode.
5. **What it can do inside.** Everything an `admin` can (`core/permissions.py`), with one
   exception: it **cannot create, re-role or remove accounts** in the household (`admin:accounts`
   writes). Platform access ends when the platform session ends, and the operator can't leave a
   standing admin behind. The household's first admin is the one exception, created by
   `POST /api/v1/platform/households` (7).
6. **Audit, visible to the family.** Every enter and exit, and every write made through a
   platform session, writes a household `audit_events` row with `via: "platform"` and the
   operator's account, plus a `platform_audit_events (account_id, household_id, action,
   created_at)` row outside RLS. The household's admins see platform entries in their activity
   view. ADR-0017 makes that disclosure part of what a family agrees to.
7. **Households.** `POST /api/v1/platform/households {name, first_admin_email,
   first_admin_display_name}` creates the household and sends its first admin the ADR-0015 invite
   (72-hour link, they choose their own password). This replaces `bootstrap` for every household
   after the first. `POST …/{id}/disable` and `…/enable` refuse sign-ins and joins without
   deleting anything. `POST …/{id}/rotate-slug` rotates the join slug.
8. **Surface.** A separate `/platform` area lists households. While a household is entered, the
   family portal shows a fixed banner that can't be dismissed ("Platform access: *Household
   name*. Exit"), in a color no household theme uses, so the operator always knows "mine or
   theirs" (qrMemorial's rule).
9. **The owner's own family.** `rbjengineeringservices.llc@gmail.com` is a platform operator
   *and* the Baez Family admin through its ordinary `accounts` row. For the Baez Family it uses
   the ordinary `fnh_session`, so the family's audit doesn't fill with platform entries for their
   own admin.
10. **No migration of household data.** No household table, policy or permission changes. New:
    `platform_operators`, `platform_audit_events`, `households.disabled_at`, the `fnh_platform`
    role and one function.

## Options considered

### A. Super-admin (**chosen**)

As above.

- ✅ The operator can resolve any support case ("my photo is missing") directly, as qrMemorial's
  super user does.
- ✅ No RLS bypass: one household per session, bound server-side, same isolation tests.
- ❌ **Highest blast radius in the system.** An operator's password plus one 4-hour cookie reads
  one family's photos, ballots and children per entry, and any family on demand. A bug in the
  enter path or in cookie verification reaches every household. Mitigations: CLI-only grant, a
  separate sign-in, short absolute sessions, a per-request operator re-check, an audit the family
  can see. A second factor on platform sign-in was considered and declined (below).
- ❌ The promise to families gets weaker: "the operator can open your household, and you'll see
  when they do", not "the operator can't see your photos." ADR-0017 has to say so plainly.

### B. Operator over the deployment, content-blind (rejected by the owner)

A platform role that manages households (create, list metadata, health, disable) through
metadata-only definer functions and **never** enters one. It can't read people, photos or ballots
unless it is also that family's admin.

- ✅ A platform bug leaks counts, not photos. The strongest consent story.
- ❌ Support cases need the family's admin to look. The owner judged that cost too high.

Most of B survives inside A: the metadata-only listing, CLI-granted identity, separate session,
separate surface and its own audit trail.

### C. Status quo: the operator is "whoever has `fly ssh`" (rejected as the end state)

- ✅ Nothing to build. Still correct while there is one household, which is today.
- ❌ SSH is full database access, broader than A and unlogged by the app. Doesn't scale past a
  handful of households.

C stays in force until ADR-0017 is accepted and A is built.

## Consequences

- **Sequencing:** ADR-0017 (consent and multi-household) is accepted first, then A is built.
  Until then the owner is the operator through `fly ssh` and the CLI, and the Baez admin through
  the ordinary account.
- ADR-0003 now reads: the household comes from the device, the account session, **or a platform
  session bound by an explicit, audited enter**. Never from a client parameter. Cross-household
  is still 404.
- ADR-0009's pre-auth surface grows by one function and one role. `test_rls_coverage.py` pins
  both.
- 03-backend.md "Auth & authorization" gains a third principal (`fnh_platform` cookie, resolved
  by a `CurrentPlatformOperator` dependency) and a "Platform" section.
- **Tests** (when built): an operator entered in household A reads and writes A, and gets 404 for
  every B resource. The list returns metadata only (the function's exact columns pinned). A family
  session gets 401 on `/platform`. A revoked operator's cookie dies on the next request. Platform
  writes are audited `via: "platform"`. Account writes are 403 through a platform session. A
  disabled household refuses sign-in and join.
- **TOTP on platform sign-in: declined by the owner (2026-10-19).** The password re-entry,
  4-hour absolute session, CLI-only grant and family-visible audit are the controls. Revisit if
  the platform ever has more than one operator.
- `bootstrap` remains only for the very first household and operator.

## Owner decision

- [x] **Option A**, the qrMemorial super-user model adapted to RLS (2026-10-19). B and C are
      recorded above as rejected.
- [x] The consent / multi-household ADR ([ADR-0017](ADR-0017-consent-and-multi-household.md))
      comes before any A code.
