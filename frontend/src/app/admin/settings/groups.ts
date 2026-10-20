/**
 * Settings groups (proposals/owner-portal.md §5 P5): which groups a role sees, which group's Save
 * is the screen's one primary, and each group's PATCH body with only what changed. React-free so
 * it is unit-tested.
 */
import {
  type AgeCapValue,
  ageCapFromSelect,
  NO_AGE_CAP,
  normalizeRegion,
  sameIds,
} from "@/lib/admin";
import type { VotingMethod } from "@/lib/api";
import { passwordProblem } from "@/lib/password";

export type Role = "admin" | "host";
export type GroupId =
  "joining" | "nights" | "streaming" | "accounts" | "data" | "account" | "browser";
export type Group = { id: GroupId; label: string; adminOnly: boolean };

export const SETTINGS_GROUPS: readonly Group[] = [
  { id: "joining", label: "Joining", adminOnly: true },
  { id: "nights", label: "Movie nights", adminOnly: true },
  { id: "streaming", label: "Streaming", adminOnly: true },
  // Issue #71: invite another adult as host or admin.
  { id: "accounts", label: "Hosts & admins", adminOnly: true },
  // ADR-0017 §4: download everything, or delete the household.
  { id: "data", label: "Your household's data", adminOnly: true },
  { id: "account", label: "Your account", adminOnly: false },
  { id: "browser", label: "This browser", adminOnly: false },
];

/** A host sees only the groups that don't need `admin:settings`. */
export function visibleGroups(role: Role): Group[] {
  return SETTINGS_GROUPS.filter((g) => role === "admin" || !g.adminOnly);
}

/**
 * Groups with unsaved changes, oldest edit first. Rule 1 (one primary per screen): only the last
 * one's Save is filled; the others stay saveable but `secondary`.
 */
export type DirtyOrder = readonly GroupId[];

export function markDirty(order: DirtyOrder, group: GroupId, dirty: boolean): DirtyOrder {
  const rest = order.filter((g) => g !== group);
  if (dirty) return order.at(-1) === group ? order : [...rest, group];
  return rest.length === order.length ? order : rest;
}

export type SaveLook = "primary" | "secondary" | "idle";

/** primary: filled, `data-testid="primary-action"`; secondary: enabled; idle: disabled. */
export function saveLook(order: DirtyOrder, group: GroupId): SaveLook {
  if (order.at(-1) === group) return "primary";
  return order.includes(group) ? "secondary" : "idle";
}

type Patch<T> = { error: string } | { body: T };

/** Movie nights: default voting method and age cap, only the fields that changed. */
type NightsBody = { default_voting_method?: VotingMethod; default_age_cap?: AgeCapValue | null };

export function nightsPatch(
  saved: { default_voting_method: VotingMethod; default_age_cap: AgeCapValue | null },
  draft: { method: VotingMethod; ageCap: string },
): NightsBody {
  const body: NightsBody = {};
  if (draft.method !== saved.default_voting_method) body.default_voting_method = draft.method;
  const cap = ageCapFromSelect(draft.ageCap);
  if (cap !== saved.default_age_cap) body.default_age_cap = cap;
  return body;
}

/** The age-cap `<select>` value for a saved cap. */
export function ageCapSelectValue(cap: AgeCapValue | null): string {
  return cap ?? NO_AGE_CAP;
}

/**
 * Streaming: region and services, only what changed. The region is checked here (two letters);
 * an unparseable region is "changed" so the group stays dirty and Save explains why.
 */
export function streamingPatch(
  saved: { region: string; streaming_providers: readonly number[] },
  draft: { region: string; providers: readonly number[] },
): Patch<{ region?: string; streaming_providers?: number[] }> {
  const region = normalizeRegion(draft.region);
  if (!region) return { error: "Use a two-letter country code, like US or GB." };
  const body: { region?: string; streaming_providers?: number[] } = {};
  if (region !== saved.region) body.region = region;
  if (!sameIds(draft.providers, saved.streaming_providers)) {
    body.streaming_providers = [...draft.providers];
  }
  return { body };
}

export function streamingDirty(
  saved: { region: string; streaming_providers: readonly number[] },
  draft: { region: string; providers: readonly number[] },
): boolean {
  const patch = streamingPatch(saved, draft);
  return "error" in patch || Object.keys(patch.body).length > 0;
}

export type PasswordDraft = { current: string; next: string; confirm: string };

/** Your account: anything typed in the password form is an unsaved change. */
export function passwordDirty(draft: PasswordDraft): boolean {
  return draft.current !== "" || draft.next !== "" || draft.confirm !== "";
}

/**
 * `POST /auth/password` (ADR-0014). Changing needs the current password; setting the first one
 * (`has_password` false, a magic-link account) doesn't.
 */
export function passwordPatch(
  hasPassword: boolean,
  draft: PasswordDraft,
): Patch<{ current_password?: string; new_password: string }> {
  if (hasPassword && draft.current === "") return { error: "Type your current password." };
  const problem = passwordProblem(draft.next, draft.confirm);
  if (problem) return { error: problem };
  return {
    body: hasPassword
      ? { current_password: draft.current, new_password: draft.next }
      : { new_password: draft.next },
  };
}
