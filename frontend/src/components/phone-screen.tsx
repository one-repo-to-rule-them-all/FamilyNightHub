import { cn } from "@/lib/utils";

/** The phone column: one screen, one job, thumb-reachable (04-frontend.md). */
export function PhoneScreen({
  title,
  lede,
  children,
  className,
  screen,
}: {
  title: string;
  lede?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** `data-screen`: the guest-flow spec's screen id, for Playwright (spec §4 rule 8). */
  screen?: string;
}) {
  return (
    <main
      data-screen={screen}
      className={cn("mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-5 py-8", className)}
    >
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">{title}</h1>
        {lede ? <p className="text-lg text-muted-foreground">{lede}</p> : null}
      </header>
      {children}
    </main>
  );
}
