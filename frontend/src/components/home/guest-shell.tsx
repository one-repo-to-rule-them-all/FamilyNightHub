"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

import { AppBar } from "@/components/home/app-bar";
import { BottomNav } from "@/components/home/bottom-nav";
import { NightToast } from "@/components/home/night-toast";
import { useHouseholdNight } from "@/hooks/use-household-night";
import { usePhonePeople } from "@/hooks/use-phone";
import { activeTab } from "@/lib/home";
import { parseLastJoin, readLastJoinRaw } from "@/lib/last-join";
import { cn } from "@/lib/utils";

const noSubscribe = () => () => {};

/**
 * The signed-in phone's frame (guest-home §3.1, §5 H0): the app bar, the page, the bottom nav, and
 * the new-night toast (H0c, issue #70) mounted once here, so it shows on every signed-in screen and
 * follows the phone from screen to screen. Mounting it on every signed-in screen mounts the
 * live-night poll there too, which is what fixes the staging dead end (finding F1).
 *
 * - `screen`: the page's `data-screen` (guest-flow §4 rule 8), set on the `<main>`.
 * - `hideNav`: the ballot, whose sticky Done owns the bottom of the screen.
 */
export function GuestShell({
  screen,
  back,
  hideNav = false,
  className,
  children,
}: {
  screen: string;
  back?: { href: string; label: string };
  hideNav?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const { people, current } = usePhonePeople();
  const { night, isNew } = useHouseholdNight(people.isSuccess);
  const lastJoin = parseLastJoin(useSyncExternalStore(noSubscribe, readLastJoinRaw, () => null));

  return (
    <div className="group/shell flex min-h-dvh flex-1 flex-col">
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
          // …and above the toast while it shows, so it never hides the end of the page.
          "group-has-[[data-toast]]/shell:pb-[calc(3.5rem+env(safe-area-inset-bottom,0px)+11rem)]",
          className,
        )}
      >
        {children}
      </main>
      <NightToast night={night} isNew={isNew} pathname={pathname} aboveNav={!hideNav} />
      {hideNav ? null : <BottomNav active={activeTab(pathname)} live={night !== undefined} />}
    </div>
  );
}
