import { Check } from "lucide-react";

import { calledSet, type CallLike, DECK_TOTAL } from "@/lib/loteria";
import { cardById, DECK } from "@/lib/loteria-deck";
import { cn } from "@/lib/utils";

/**
 * Lotería pieces shared by the host panel, the phone and the TV (ADR-0018 amendment 2026-11-26):
 * the card that was just called, large, and the 54-picture called board. The picture is an emoji;
 * the Spanish name always accompanies it (and is the accessible name), and a called picture on the
 * board is a filled tile with a check glyph, never colour alone. `tv` sizes in `em` off the TV
 * root; `host` uses rem.
 */
export function CurrentCard({
  cardId,
  variant,
  testId,
}: {
  cardId: number | null;
  variant: "tv" | "host" | "phone";
  testId: string;
}) {
  const card = cardId === null ? null : cardById(cardId);
  const big = variant === "tv" ? "9em" : variant === "host" ? "6rem" : "4.5rem";
  return (
    <div
      className="flex flex-col items-center gap-2 text-center"
      aria-live="polite"
      aria-label={card ? `Last card ${card.es}, ${card.en}` : "No card called yet"}
    >
      <span
        aria-hidden
        data-testid={`${testId}-emoji`}
        className="leading-none"
        style={{ fontSize: big }}
      >
        {card ? card.emoji : "🂠"}
      </span>
      <p
        data-testid={testId}
        data-card-id={card?.id}
        className={cn(
          "font-heading leading-tight font-bold",
          variant === "tv" ? "text-[3.2em]" : variant === "host" ? "text-4xl" : "text-3xl",
        )}
      >
        {card ? card.es : "—"}
      </p>
      {card ? (
        <p className={cn("text-muted-foreground", variant === "tv" ? "text-[1.2em]" : "text-base")}>
          {card.en}
        </p>
      ) : null}
    </div>
  );
}

export function LoteriaCalledBoard({
  calls,
  variant,
}: {
  calls: readonly CallLike[];
  variant: "tv" | "host";
}) {
  const called = calledSet(calls);
  const tv = variant === "tv";
  return (
    <div
      role="group"
      aria-label={`Called cards: ${calls.length} of ${DECK_TOTAL}`}
      data-testid="loteria-called-board"
      data-count={calls.length}
      className={cn("grid w-full grid-cols-9", tv ? "gap-[0.25em] text-[1em]" : "gap-1 text-sm")}
    >
      {DECK.map((card) => {
        const isCalled = called.has(card.id);
        return (
          <span
            key={card.id}
            data-testid="loteria-called-cell"
            data-card-id={card.id}
            data-called={isCalled}
            aria-label={`${card.es} ${isCalled ? "called" : "not called"}`}
            className={cn(
              "relative flex flex-col items-center justify-center rounded-md border leading-none",
              tv ? "min-h-[3.2em] p-[0.15em]" : "min-h-12 p-0.5",
              isCalled
                ? "border-[var(--accent-cinema)] bg-[var(--accent-cinema)]/25 font-bold text-foreground"
                : "border-foreground/10 text-muted-foreground/60 opacity-60",
            )}
          >
            {isCalled ? (
              <Check
                aria-hidden
                className="absolute top-0.5 right-0.5 size-3 text-[var(--accent-cinema)]"
              />
            ) : null}
            <span aria-hidden className={tv ? "text-[1.6em]" : "text-xl"}>
              {card.emoji}
            </span>
          </span>
        );
      })}
    </div>
  );
}
