import { History, House, type LucideIcon, Smile } from "lucide-react";
import Link from "next/link";

import { GUEST_TABS, type GuestTab, HOME_COPY } from "@/lib/home";
import { cn } from "@/lib/utils";

const ICONS: Record<GuestTab, LucideIcon> = { home: House, history: History, me: Smile };

/**
 * The guest bottom nav (guest-home §4 rule 2, §5 H0): Home, History, Me as links styled as nav,
 * never the primary. 56px plus the safe area. A cinema dot on Home says a night is live.
 */
export function BottomNav({ active, live }: { active: GuestTab | null; live: boolean }) {
  return (
    <nav
      aria-label="Main"
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-foreground/10 bg-card pb-[env(safe-area-inset-bottom,0px)]"
    >
      <ul className="mx-auto flex w-full max-w-md">
        {GUEST_TABS.map((tab) => {
          const Icon = ICONS[tab.key];
          const current = active === tab.key;
          return (
            <li key={tab.key} className="flex-1">
              <Link
                href={tab.href}
                data-nav={tab.key}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative flex h-14 flex-col items-center justify-center gap-0.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  current ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="relative">
                  <Icon aria-hidden className="size-6" />
                  {tab.key === "home" && live ? (
                    <span
                      role="img"
                      aria-label={HOME_COPY.nav.live}
                      data-testid="live-dot"
                      className="absolute -top-0.5 -right-1 size-2.5 rounded-full bg-cinema ring-2 ring-card"
                    />
                  ) : null}
                </span>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
