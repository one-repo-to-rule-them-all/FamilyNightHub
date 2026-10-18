"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { GuestShell } from "@/components/home/guest-shell";
import { usePhonePeople } from "@/hooks/use-phone";
import { HOME_COPY } from "@/lib/home";
import { cn } from "@/lib/utils";

import { historyTab, type HistoryTab } from "./history";
import { HistoryList } from "./history-list";
import { MineList } from "./mine-list";

const TABS: { id: HistoryTab; label: string }[] = [
  { id: "mine", label: HOME_COPY.hist.mine },
  { id: "family", label: HOME_COPY.hist.family },
];

/**
 * H2 History (guest-home §5 H2): tabs **Mine** (default) and **Family**, the tab in `?tab=` so
 * Back and reload keep it. A browse screen: no primary except the shell's live hand-off.
 */
export function HistoryScreen() {
  const tab = historyTab(useSearchParams().get("tab"));
  const { current, noDevice } = usePhonePeople();

  return (
    <GuestShell screen="history" back={{ href: "/", label: HOME_COPY.nav.home }}>
      <div className="flex flex-col gap-4" data-tab={tab} data-testid="history">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          {HOME_COPY.hist.title}
        </h1>
        <div
          role="tablist"
          aria-label={HOME_COPY.hist.title}
          className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1"
        >
          {TABS.map((t) => (
            <Link
              key={t.id}
              role="tab"
              id={`history-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="history-panel"
              href={`/history?tab=${t.id}`}
              replace
              scroll={false}
              data-testid={`history-tab-${t.id}`}
              className={cn(
                "flex h-12 items-center justify-center rounded-lg text-base font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring",
                tab === t.id && "bg-card text-foreground ring-1 ring-foreground/10",
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
        <div
          role="tabpanel"
          id="history-panel"
          aria-labelledby={`history-tab-${tab}`}
          className="flex flex-col gap-3"
        >
          {tab === "family" ? (
            <HistoryList />
          ) : current ? (
            <MineList personId={current.id} />
          ) : noDevice ? (
            <p role="alert" className="rounded-xl bg-card p-5 text-lg">
              Join a movie night on this phone to see your family&apos;s past nights.
            </p>
          ) : (
            <p className="text-lg text-muted-foreground" data-testid="history-empty">
              {HOME_COPY.empty.mine}
            </p>
          )}
        </div>
      </div>
    </GuestShell>
  );
}
