# ADR-0017: Consent, privacy and deletion before a second household

## Status

**Proposed: needs the owner's approval** (issue #77). This is the ADR that
[ADR-0003](ADR-0003-household-scoping-app-plus-rls.md) ("multi-household requires a new ADR
covering parental consent, privacy policy, retention and deletion"),
[BUILD-PROMPT](../BUILD-PROMPT.md) Phase 3+ and [ADR-0016](ADR-0016-platform-owner.md) wait on.
Nothing in the code implements it, and ADR-0016's platform owner isn't built until it is accepted.

Not legal advice. The COPPA points below are a cautious engineering reading. A short legal review
is a precondition of step 2 (below), not something this ADR can replace.

## Context

Today one household exists, the owner's own, and the owner consents for their own children by
running the app. A second household changes that:

- **Children are users, not only subjects.** They join on their own phones, claim their person
  with a PIN, vote and react, and may drop photos (ADR-0002, ADR-0005, ADR-0014). Their names,
  faces and choices are stored.
- **The operator can enter any household** (ADR-0016, option A). A family has to know that before
  it trusts the app with its children.
- **Nothing exists for strangers:** no terms, no privacy policy, no consent record, no household
  export or delete, no billing, no abuse handling.
- **Accounts are unique across households** (ADR-0014, ADR-0015), so one family's admin can learn
  that an address is in use elsewhere.

qrMemorial opened self-serve signup behind a one-time payment (its ADR-0008) without a consent
step, and its legal pages are still an open issue (#61). Its content is public by design and about
a deceased adult. FamilyNight's is private and about living children, so it needs more before it
opens.

## Decision (proposed)

### 1. Who can get a household: operator-created only, no public signup

The platform owner creates every household (ADR-0016 §7) for families they know, and invites its
first admin. There's no signup page, billing or self-serve onboarding.

- Keeps the audience to known families while the consent and deletion paths prove themselves.
- Billing, abuse handling and public signup stay out of scope. Opening signup to strangers needs
  its own ADR, and that ADR must cover verifiable parental consent, billing and abuse.

### 2. The first admin consents, as parent or guardian, before any child data exists

- Accepting the ADR-0015 invite as a **household's first admin** adds a required consent step
  before the password is set. The first admin confirms they are a parent or legal guardian of the
  children they'll add and accepts the current **Terms** and **Privacy Policy**.
- A new table `household_consents (household_id, account_id, terms_version, privacy_version,
  accepted_at)` is under RLS, and rows are never updated or deleted (corrections are new rows).
- **Gate:** until the household has a consent row for the current versions, the API refuses to
  create people, join devices or accept photos (409 `consent_required`). The gate lives in the
  services, not the UI.
- **New versions:** a material change bumps the version. The next admin sign-in shows the change
  and asks for acceptance again. Until then the household keeps working, but the gate blocks new
  people. Every acceptance is audited.
- Later admins and hosts accept the Terms at invite acceptance. Only the first admin's row (or a
  later admin's re-acceptance) satisfies the gate.
- **Before step 2 runs for any family outside the owner's own**, get a short legal review of
  whether this "parent enters and supervises" consent is enough under COPPA for a private,
  invite-only service, or whether verifiable parental consent is needed.

### 3. Terms and Privacy Policy say what actually happens

Versioned pages served at `/legal/terms` and `/legal/privacy` (Markdown in the repo, version in
the front matter). Each item below is required text:

- What's stored about children (name, emoji, color, PIN hash, votes, ratings, photos, devices),
  and that it's visible inside the household.
- **Operator access (ADR-0016):** the operator can open the household to provide support. Every
  opening is logged and shown to the household's admins.
- Where data lives (Fly.io, Tigris, the email provider, TMDB lookups without personal data),
  and that no data is sold or used for ads or AI training.
- Retention and deletion (§4), and how to request them.

### 4. Retention, export and deletion

- **Export:** the deferred zip export (BUILD-PROMPT Phase 3) becomes a precondition of the second
  household. An admin downloads people, nights, ballots, ratings and original photos.
- **Household delete:** an admin requests it with their password, a typed household name and a
  7-day cooling-off period (cancellable). The worker then hard-deletes every household row and
  every bucket object, tombstoning photos the way `photo_deletions` already does so the backup
  mirror purges within 24 hours. Database backups age out on their own schedule (05-data.md:
  7 daily snapshots, 8 weekly dumps), so the stated window is **"gone from the live service in 7
  days, from all backups within 60."** The operator can carry out a delete on request through the
  same path.
- **Person delete:** an admin can delete a child's person, not only merge it, with the same
  photo tombstoning.
- **Disabled households** (ADR-0016) keep their data until deleted, with a reminder to the admin
  after 12 months.

### 5. Cross-household identity: accept the uniqueness leak for now

Keep emails and usernames unique across households (ADR-0014). With operator-created households
for known families, "this address is in use" leaks little. **Revisit, and likely move to global
accounts with per-household memberships, before public signup.** That's a login change touching
ADR-0014 and ADR-0015.

### 6. The platform view's fields

ADR-0016 §3's list (name, created, disabled, counts of people, devices, nights and photos, last
activity) is accepted as is. Admin emails are not listed: the operator sees them by entering the
household, which is audited. Storage used is added only when billing needs it.

## Alternatives considered

**Self-serve signup now, like qrMemorial.** Rejected for this stage: strangers' children, no
billing and no abuse handling. qrMemorial's content is public and about adults.

**Consent per child, from each child's parent.** More precise when households span families (a
cousin's kid at movie night), but guests already don't get stored profiles by default
(`is_guest`). Deferred until a household asks for it.

**No consent gate, only a terms link.** Rejected: a link nobody accepted is no record, and
ADR-0003 named consent as the condition.

## Consequences

- **Order of work** once accepted: legal pages and versions, the consent table and gate, person
  delete, export, household delete, then ADR-0016's platform owner, then the second household.
- The owner's own household gets a consent row too (the owner accepts at their next sign-in), so
  the gate is one code path with no "first household" exception.
- New tests: the gate refuses people, joins and photos without current consent. Consent rows are
  append-only and cross-household 404. Household delete removes every row and object (asserted
  per table via the RLS coverage list). Export contains every table the household owns.
- 05-data.md gains `household_consents`, and 03-backend.md gains "Consent" and "Household
  deletion".

## Owner decision needed

- [ ] §1 Operator-created households only, no public signup.
- [ ] §2 First-admin consent with a hard gate, plus a legal review before any family outside the
      owner's own.
- [ ] §3 Terms and Privacy items, including the operator-access disclosure.
- [ ] §4 Export, household delete (7 days live, 60 days backups), person delete.
- [ ] §5 Accept the email-uniqueness leak until public signup.
- [ ] §6 Platform view fields as listed.
- [ ] Or: change any of the above, with reasons recorded here.
