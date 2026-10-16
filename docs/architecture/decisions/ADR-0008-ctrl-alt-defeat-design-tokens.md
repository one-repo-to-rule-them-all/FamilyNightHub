# ADR-0008: Inherit the Ctrl+Alt+Defeat design tokens, with a cinema accent

## Status

Accepted (2026-10-15). Resolves the scope's open question "which design pattern is ctrl alt
defeat?" (answer: the `gaming-league-tracker` app).

## Context

The scope asked for FieldPro's redesign tokens. FieldPro runs Tailwind v3 on Next 14 with
light-only tokens. Ctrl+Alt+Defeat (CAD) runs Tailwind v4 with shadcn `base-nova`, oklch tokens,
Geist fonts and a dark-first theme with a single gold accent. That is the same frontend stack FNH
targets, and dark-first suits a living-room TV.

## Decision

Copy CAD's `app/globals.css` token block and `components/ui` primitives into
`frontend/src/app/globals.css` and `frontend/src/components/ui`. Swap the gold accent for a
**marquee red/amber cinema accent** (`--accent-cinema`), keeping the "one accent, used only for
primary actions and winners" rule. Dark is the default.

## Alternatives considered

**FieldPro tokens.** Rejected: Tailwind v3 port, light-only, and a different component library.

**Shared npm package across apps.** Deferred until a third app needs the tokens. Copying with a
header comment naming the source commit is cheaper today.

## Consequences

- Visual kinship with CAD. Token drift between the two apps is accepted; the copied file records the
  CAD commit it came from.
- Phone UI needs larger tap targets than CAD (minimum 56px) and a poster-first layout. TV mode uses
  its own type scale.
- axe-core checks run in Playwright, as in CAD ([`07-cicd.md`](../07-cicd.md)).
