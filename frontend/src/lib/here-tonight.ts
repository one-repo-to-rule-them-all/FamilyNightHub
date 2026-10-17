/**
 * The phone's "Here tonight" strip (guest-flow spec §5, owner request 2026-10-17): who is here
 * and, while voting, who has voted. Never how anyone voted (ADR-0006): the inputs carry ids,
 * avatars and a voted flag only.
 */
import type { NightStatus, PresentPerson } from "@/lib/api";

export type HereItem = {
  personId: string;
  name: string | null;
  avatarEmoji: string;
  color: string;
  voted: boolean;
  isGuest: boolean;
};

type Named = { id: string; name: string; is_guest: boolean };

/**
 * One row per person, family first then guests, in the server's order (G8's attendance list).
 * Names come from the people list the phone already holds.
 */
export function hereTonight(
  present: readonly PresentPerson[],
  people: readonly Named[],
): HereItem[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const items = present.map((row) => {
    const person = byId.get(row.person_id);
    return {
      personId: row.person_id,
      name: person?.name ?? null,
      avatarEmoji: row.avatar_emoji,
      color: row.color,
      voted: row.voted,
      isGuest: person?.is_guest ?? true,
    };
  });
  return [...items.filter((i) => !i.isGuest), ...items.filter((i) => i.isGuest)];
}

/** Hidden until someone other than this phone's person is here (spec: yourself adds nothing). */
export function showHereStrip(items: readonly HereItem[], selfId: string | null): boolean {
  return items.some((i) => i.personId !== selfId);
}

/** The strip's count line: `copy.here.countVoting` while voting, `copy.here.count` otherwise. */
export function hereCount(items: readonly HereItem[], status: NightStatus): string {
  if (status !== "voting") return `${items.length} here`;
  const voted = items.filter((i) => i.voted).length;
  return `${items.length} here · ${voted} voted`;
}

/** Avatars that fit before the rest collapse into `+N`. */
export function overflow<T>(items: readonly T[], max: number): { shown: T[]; more: number } {
  if (items.length <= max) return { shown: [...items], more: 0 };
  return { shown: items.slice(0, max - 1), more: items.length - (max - 1) };
}
