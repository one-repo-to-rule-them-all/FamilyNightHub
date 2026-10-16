/**
 * Pure shortlist and ballot logic for the host screen (04-frontend.md "Host screens").
 *
 * The server owns the order (`options[].position`); the reducer keeps the host's local order so a
 * move renders at once, and `sync` puts the server's answer back after every write.
 */

/** Open voting needs 2..8 titles (03-backend.md, session_state.MAX_OPTIONS). */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 8;

export type ShortlistState = { ids: string[] };

export type ShortlistAction =
  | { type: "sync"; ids: string[] }
  | { type: "move"; id: string; delta: number }
  | { type: "remove"; id: string };

export function shortlistReducer(state: ShortlistState, action: ShortlistAction): ShortlistState {
  switch (action.type) {
    case "sync":
      return sameOrder(state.ids, action.ids) ? state : { ids: [...action.ids] };
    case "move": {
      const ids = moveOption(state.ids, action.id, action.delta);
      return ids === state.ids ? state : { ids };
    }
    case "remove":
      return state.ids.includes(action.id)
        ? { ids: state.ids.filter((id) => id !== action.id) }
        : state;
  }
}

/** `id` moved by `delta` places, clamped to the ends. The same array when nothing moves. */
export function moveOption(ids: string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  if (from === -1 || delta === 0) return ids;
  const to = Math.min(ids.length - 1, Math.max(0, from + delta));
  if (to === from) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export function canAddOption(count: number): boolean {
  return count < MAX_OPTIONS;
}

export function canOpenVoting(count: number): boolean {
  return count >= MIN_OPTIONS && count <= MAX_OPTIONS;
}

/** Ballot size k = min(3, n - 1) (ADR-0006). The server fixes it on open; this is for display. */
export function ballotSize(optionCount: number): number {
  return Math.max(0, Math.min(3, optionCount - 1));
}

/**
 * Tap-to-rank for the proxy ballot (same rule as the phone ballot, 04-frontend.md): tapping an
 * unranked title gives it the next rank (until `k` are ranked); tapping a ranked one clears it and
 * closes the gap, so ranks always run 1..m.
 */
export function toggleRank(ranked: string[], id: string, k: number): string[] {
  if (ranked.includes(id)) return ranked.filter((r) => r !== id);
  if (ranked.length >= k) return ranked;
  return [...ranked, id];
}

/** The ranks as the API's BallotIn wants them. */
export function toRanks(ranked: string[]): { option_id: string; rank: number }[] {
  return ranked.map((option_id, i) => ({ option_id, rank: i + 1 }));
}
