/**
 * Unsaved ballot picks, kept for this tab (guest-home §5 "Live-night screens", S10): leaving the
 * ballot through **‹ Home** and coming back restores them. Keyed by night and person, so a shared
 * phone never shows one person's picks to the next. `sessionStorage` can throw (private mode,
 * blocked storage), so every access is guarded and a failure just means nothing is restored.
 */
export type DraftRank = { option_id: string; rank: number };

export function ballotDraftKey(nightId: string, personId: string): string {
  return `fnh.ballotDraft.${nightId}.${personId}`;
}

function isRank(value: unknown): value is DraftRank {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.option_id === "string" && typeof r.rank === "number";
}

/** The saved draft, or null when there is none (or it can't be read). */
export function readBallotDraft(nightId: string, personId: string): DraftRank[] | null {
  try {
    const raw = window.sessionStorage.getItem(ballotDraftKey(nightId, personId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isRank) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeBallotDraft(nightId: string, personId: string, ranks: DraftRank[]): void {
  try {
    window.sessionStorage.setItem(ballotDraftKey(nightId, personId), JSON.stringify(ranks));
  } catch {
    // Storage unavailable: the picks just aren't restored.
  }
}

export function clearBallotDraft(nightId: string, personId: string): void {
  try {
    window.sessionStorage.removeItem(ballotDraftKey(nightId, personId));
  } catch {
    // Nothing to clear.
  }
}

/** True when the draft holds picks that differ from what the server has saved. */
export function draftDiffers(draft: DraftRank[] | null, saved: DraftRank[]): boolean {
  if (draft === null) return false;
  const key = (ranks: DraftRank[]) =>
    [...ranks]
      .sort((a, b) => a.rank - b.rank)
      .map((r) => `${r.rank}:${r.option_id}`)
      .join(",");
  return key(draft) !== key(saved);
}
