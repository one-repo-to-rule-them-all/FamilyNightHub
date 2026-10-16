/**
 * How each voting method is explained and scored on screen (ADR-0006, ADR-0010). Pure.
 *
 * The host picks a method in the draft; the TV's reveal labels each placement's score in the
 * method's own unit and says which tie-break step settled the winner.
 */

import type { Night, VotingMethod } from "@/lib/api";

type Tiebreak = NonNullable<Night["result"]>["tiebreak"];

export const VOTING_METHODS: { value: VotingMethod; label: string; explanation: string }[] = [
  {
    value: "top3",
    label: "Top 3",
    explanation: "Everyone ranks up to three; 1st is worth the most points.",
  },
  {
    value: "approval",
    label: "Approval",
    explanation: "Everyone ticks every movie they'd happily watch; most ticks wins.",
  },
  {
    value: "pick_one",
    label: "Pick one",
    explanation: "Everyone picks a single movie; most votes wins.",
  },
];

const UNITS: Record<VotingMethod, [string, string]> = {
  top3: ["point", "points"],
  approval: ["approval", "approvals"],
  pick_one: ["vote", "votes"],
};

/** "5 points", "1 approval", "2 votes". */
export function scoreLabel(method: VotingMethod, score: number): string {
  const [one, many] = UNITS[method];
  return `${score} ${score === 1 ? one : many}`;
}

/** Why the winner beat the options level with it, or null when nothing was level. */
export function tiebreakNote(method: VotingMethod, tiebreak: Tiebreak): string | null {
  switch (tiebreak) {
    case "none":
      return null;
    case "first_places":
      return method === "approval"
        ? "Tie broken by who was picked alone most often"
        : "Tie broken by first-place votes";
    case "head_to_head":
      return "Tie broken head-to-head";
    case "random":
      return "Tie broken by a coin flip";
  }
}
