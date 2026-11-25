import { boardRows, calledSet, type CallLike } from "@/lib/bingo";
import { cn } from "@/lib/utils";

/**
 * The classic bingo board (ADR-0018 amendment, part A): five rows B-I-N-G-O of fifteen numbers,
 * the called ones filled. Shared by the host panel and the TV. A called number is bold and filled
 * and its accessible name says so, so it never rests on colour alone. `tv` sizes in `em` off the
 * TV root; `host` uses rem.
 */
export function CalledBoard({
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
      aria-label={`Called numbers: ${calls.length} of 75`}
      data-testid="bingo-called-board"
      data-count={calls.length}
      className={cn("flex w-full flex-col", tv ? "gap-[0.2em] text-[1.05em]" : "gap-1 text-sm")}
    >
      {boardRows().map(({ letter, values }) => (
        <div
          key={letter}
          className={cn(
            "grid grid-cols-[1.6em_repeat(15,minmax(0,1fr))]",
            tv ? "gap-[0.2em]" : "gap-1",
          )}
        >
          <span aria-hidden className="flex items-center justify-center font-heading font-bold">
            {letter}
          </span>
          {values.map((value) => {
            const isCalled = called.has(value);
            return (
              <span
                key={value}
                data-testid="called-cell"
                data-value={value}
                data-called={isCalled}
                aria-label={`${letter}${value} ${isCalled ? "called" : "not called"}`}
                className={cn(
                  "flex items-center justify-center rounded-md border tabular-nums",
                  tv ? "min-h-[1.9em]" : "min-h-7",
                  isCalled
                    ? "border-[var(--accent-cinema)] bg-[var(--accent-cinema)]/25 font-bold text-foreground"
                    : "border-foreground/10 text-muted-foreground/60",
                )}
              >
                {value}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
