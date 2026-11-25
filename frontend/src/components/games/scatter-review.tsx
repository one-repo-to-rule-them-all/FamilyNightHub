"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, CheckCheck } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import {
  api,
  type ApiError,
  type ScatterReview,
  type ScatterReviewItem,
  type ScatterRevealed,
  type ScatterState,
} from "@/lib/api";
import {
  autoAcceptedLine,
  countedSeparately,
  informationalLabel,
  pointsLabel,
  reviewTitle,
} from "@/lib/scatter";
import { cn } from "@/lib/utils";

import { Results } from "./scatter-parts";

type Verdict = "accepted" | "rejected" | null;
type Standing = ScatterState["leaderboard"][number];
type ReviewAnswer = ScatterReviewItem["answers"][number];
type Change = { answerId: string; verdict: Verdict };

const TAP = "min-h-11 px-4";

/** One answer inside a card: who, what, and what it is worth right now. */
function AnswerLine({ answer, children }: { answer: ReviewAnswer; children?: ReactNode }) {
  return (
    <li
      data-testid="review-answer"
      data-verdict={answer.verdict ?? ""}
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-xl border border-foreground/10 p-3",
        answer.verdict === "rejected" && "opacity-70",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block font-medium", answer.verdict === "rejected" && "line-through")}>
          {answer.text}
        </span>
        <span className="block text-sm text-muted-foreground">{answer.name}</span>
      </span>
      <span className="tabular-nums" data-testid="review-points">
        {pointsLabel(answer.points)}
      </span>
      {children}
    </li>
  );
}

/**
 * One card that needs the host: the answers side by side and one or two plain buttons. Every
 * decision is a verdict on the existing endpoint, so nothing new is written and the TV re-scores
 * live. A decided card stays on screen so a mistap can be undone.
 */
function DecisionCard({
  item,
  busy,
  decide,
}: {
  item: ScatterReviewItem;
  busy: boolean;
  decide: (changes: Change[]) => void;
}) {
  const separate = countedSeparately(item.answers);
  const setAll = (verdict: Verdict) =>
    decide(
      item.answers
        .filter((a) => a.verdict !== verdict)
        .map((a) => ({ answerId: a.answer_id, verdict })),
    );
  const perAnswer = item.kind === "short" || !item.merged;
  return (
    <li
      data-testid="review-card"
      data-kind={item.kind}
      className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-card p-4"
    >
      <div>
        <h4 className="font-medium">{reviewTitle(item.kind, item.merged)}</h4>
        <p className="text-sm text-muted-foreground">{item.category}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {item.answers.map((answer) => {
          const rejected = answer.verdict === "rejected";
          return (
            <AnswerLine key={answer.answer_id} answer={answer}>
              {perAnswer ? (
                <Button
                  variant="outline"
                  className={TAP}
                  data-testid={rejected ? "review-keep" : "review-reject"}
                  disabled={busy}
                  onClick={() =>
                    decide([{ answerId: answer.answer_id, verdict: rejected ? null : "rejected" }])
                  }
                >
                  {rejected ? (
                    <>
                      <Check aria-hidden /> Keep
                    </>
                  ) : (
                    <>
                      <Ban aria-hidden /> Reject
                    </>
                  )}
                </Button>
              ) : null}
            </AnswerLine>
          );
        })}
      </ul>
      {item.merged ? (
        <div className="flex flex-wrap gap-3" role="group" aria-label="How should these count?">
          <Button
            variant={separate ? "outline" : "default"}
            className={TAP}
            aria-pressed={!separate}
            data-testid="review-same"
            disabled={busy}
            onClick={() => setAll(null)}
          >
            Count as the same
          </Button>
          <Button
            variant={separate ? "default" : "outline"}
            className={TAP}
            aria-pressed={separate}
            data-testid="review-separate"
            disabled={busy}
            onClick={() => setAll("accepted")}
          >
            Count separately
          </Button>
        </div>
      ) : item.kind === "near_duplicate" ? (
        <p className="text-sm text-muted-foreground">
          Spelled differently, so each counts as written. Reject one if it should not.
        </p>
      ) : null}
    </li>
  );
}

/**
 * The host's review of a revealed round (ADR-0018 amendment 2026-11-25, part C). The server lists
 * only what needs a decision; everything else already counts. Whether an answer fits its category
 * is checked by nothing: that stays the host's call, one tap away under "Show all answers".
 * "Accept the rest" writes nothing (a null verdict already counts); it only closes this review.
 */
export function ScatterReviewPanel({
  gameId,
  round,
  standings,
  onDone,
}: {
  gameId: string;
  round: ScatterRevealed;
  standings: Standing[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const review = useQuery<ScatterReview, ApiError>({
    queryKey: ["game", gameId, "review", round.round_no],
    queryFn: () => api.scatterReview(gameId, round.round_no),
  });

  const judge = useMutation<void, ApiError, Change[]>({
    mutationFn: async (changes) => {
      for (const { answerId, verdict } of changes) {
        await api.setScatterVerdict(gameId, answerId, verdict);
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["game", gameId] }),
  });

  const data = review.data;
  const needs = data?.needs_decision.length ?? 0;
  const informationalCount = data
    ? data.informational.reduce((n, item) => n + item.answers.length, 0)
    : 0;

  return (
    <section
      className="flex flex-col gap-4"
      aria-label="Review answers"
      data-testid="scatter-review"
      data-needs={data ? needs : ""}
    >
      <ApiErrorNotice error={review.error ?? judge.error} />
      {data ? (
        <>
          <p className="text-muted-foreground" data-testid="review-summary">
            {needs === 0
              ? "Nothing needs your decision. "
              : `${needs} ${needs === 1 ? "card needs" : "cards need"} your decision. `}
            <span data-testid="review-auto">{autoAcceptedLine(data.auto_accepted_count)}</span>.
            Nothing checks that an answer fits its category: look at all the answers if you want to.
          </p>

          {needs > 0 ? (
            <ul className="flex flex-col gap-3" aria-label="Needs a decision">
              {data.needs_decision.map((item) => (
                <DecisionCard
                  key={`${item.kind}-${item.category_index}-${item.answers[0]?.answer_id}`}
                  item={item}
                  busy={judge.isPending}
                  decide={(changes) => judge.mutate(changes)}
                />
              ))}
            </ul>
          ) : null}

          {data.informational.length > 0 ? (
            <details
              className="rounded-2xl border border-foreground/10 p-4"
              data-testid="review-info"
            >
              <summary className="min-h-11 cursor-pointer py-2 font-medium">
                {informationalLabel(informationalCount)}
              </summary>
              <ul className="mt-2 flex flex-col gap-3">
                {data.informational.map((item) => (
                  <li key={`${item.kind}-${item.category_index}-${item.answers[0]?.answer_id}`}>
                    <p className="text-sm font-medium">
                      {reviewTitle(item.kind, item.merged)} · {item.category}
                    </p>
                    <ul className="mt-1 flex flex-col gap-1">
                      {item.answers.map((a) => (
                        <AnswerLine key={a.answer_id} answer={a} />
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              className={TAP}
              data-testid="review-show-all"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Hide all answers" : "Show all answers"}
            </Button>
            <Button className={TAP} data-testid="review-accept-rest" onClick={onDone}>
              <CheckCheck aria-hidden /> Accept the rest
            </Button>
          </div>
        </>
      ) : null}

      {showAll ? (
        <Results
          round={round}
          standings={standings}
          action={(answer) => (
            <Button
              variant="ghost"
              size="icon-lg"
              data-testid={answer.verdict === "rejected" ? "accept-answer" : "reject-answer"}
              aria-label={`${answer.verdict === "rejected" ? "Accept" : "Reject"}: ${answer.text}`}
              disabled={judge.isPending}
              onClick={() =>
                judge.mutate([
                  {
                    answerId: answer.answer_id,
                    verdict: answer.verdict === "rejected" ? "accepted" : "rejected",
                  },
                ])
              }
            >
              {answer.verdict === "rejected" ? <Check aria-hidden /> : <Ban aria-hidden />}
            </Button>
          )}
        />
      ) : null}
    </section>
  );
}
