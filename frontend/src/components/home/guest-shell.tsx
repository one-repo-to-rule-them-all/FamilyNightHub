"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

import { AppBar } from "@/components/home/app-bar";
import { BottomNav } from "@/components/home/bottom-nav";
import { LiveHandoff } from "@/components/home/live-handoff";
import { useHouseholdNight } from "@/hooks/use-household-night";
import { usePhonePeople } from "@/hooks/use-phone";
import { activeTab, isOwnNightPath } from "@/lib/home";
import { parseLastJoin, readLastJoinRaw } from "@/lib/last-join";
import { cn } from "@/lib/utils";

const noSubscribe = () => () => {};

/**
 * The signed-in phone's frame (guest-home §3.1, §5 H0): the app bar, the page, and the bottom nav,
 * with the live hand-off at the top of the content whenever the household has a live night and
 * this isn't that night's own screen. Mounting it on every signed-in screen mounts the live-night
 * poll there too, which is what fixes the staging dead end (finding F1).
 *
 * - `screen`: the page's `data-screen` (guest-flow §4 rule 8), set on the `<main>`.
 * - `handoff`: `"plain"` (browse screens), `"countdown"` (That's a wrap and the recap: the 60 s
 *   auto-move, §5 H0c) or `"none"` (Home, which has the Tonight card, and the night's own screens).
 * - `hideNav`: the ballot, whose sticky Done owns the bottom of the screen.
 */
export function GuestShell({
  screen,
  back,
  hideNav = false,
  handoff = "plain",
  className,
  children,
}: {
  screen: string;
  back?: { href: string; label: string };
  hideNav?: boolean;
  handoff?: "plain" | "countdown" | "none";
  className?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const { people, current } = usePhonePeople();
  const { night } = useHouseholdNight(people.isSuccess);
  const lastJoin = parseLastJoin(useSyncExternalStore(noSubscribe, readLastJoinRaw, () => null));
  const showHandoff =
    handoff !== "none" && night !== undefined && !isOwnNightPath(pathname, night.id);

  return (
    <div className="flex min-h-dvh flex-1 flex-col">
      <AppBar
        householdName={lastJoin?.householdName ?? null}
        back={back}
        people={people.data}
        current={current}
      />
      <main
        data-screen={screen}
        className={cn(
          "mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-5 pt-5",
          // The last row scrolls fully above the nav (§4 rule 4).
          hideNav ? "pb-8" : "pb-[calc(3.5rem+env(safe-area-inset-bottom,0px)+1.5rem)]",
          className,
        )}
      >
        {showHandoff ? <LiveHandoff night={night} countdown={handoff === "countdown"} /> : null}
        {children}
      </main>
      {hideNav ? null : <BottomNav active={activeTab(pathname)} live={night !== undefined} />}
    </div>
  );
}
