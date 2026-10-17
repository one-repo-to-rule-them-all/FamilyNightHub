"use client";

import {
  Clapperboard,
  History,
  House,
  type LucideIcon,
  MoreHorizontal,
  Settings,
  Smartphone,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { type NavItem, type NavKey, phoneTabs } from "@/lib/portal";
import type { Role } from "@/lib/portal";
import { cn } from "@/lib/utils";

const ICONS: Record<NavKey, LucideIcon> = {
  home: House,
  people: Users,
  phones: Smartphone,
  library: Clapperboard,
  history: History,
  settings: Settings,
};

export type NavBadges = Partial<Record<NavKey, { count: number; urgent?: boolean }>>;

function Badge({
  badge,
  className,
}: {
  badge?: { count: number; urgent?: boolean };
  className?: string;
}) {
  if (!badge || badge.count === 0) return null;
  return (
    <span
      aria-label={`${badge.count} ${badge.count === 1 ? "thing needs" : "things need"} you`}
      data-testid="nav-badge"
      className={cn(
        "grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
        badge.urgent ? "bg-cinema text-primary-foreground" : "bg-muted ring-1 ring-foreground/10",
        className,
      )}
    >
      {badge.count}
    </span>
  );
}

/** Desktop/tablet sidebar (§3.2): wordmark, nav, account footer. */
export function PortalSidebar({
  items,
  active,
  badges,
  householdName,
  accountLine,
  footer,
}: {
  items: NavItem[];
  active: NavKey | null;
  badges: NavBadges;
  householdName: string;
  accountLine: string;
  footer?: React.ReactNode;
}) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-1 border-r border-foreground/10 bg-card/60 px-3 py-5 md:flex">
      <div className="flex flex-col px-2.5 pb-4">
        <span className="font-heading text-base font-semibold">Family Night</span>
        <span className="text-xs text-muted-foreground">{householdName}</span>
      </div>
      <nav aria-label="Portal">
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => {
            const Icon = ICONS[item.key];
            const current = active === item.key;
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  data-nav={item.key}
                  className={cn(
                    "flex h-10 items-center gap-2.5 rounded-lg px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    current
                      ? "bg-secondary font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon aria-hidden className="size-4.5" />
                  <span>{item.label}</span>
                  <Badge badge={badges[item.key]} className="ml-auto" />
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-foreground/10 px-2.5 pt-3">
        <span className="text-xs text-muted-foreground" data-testid="portal-signed-in-as">
          {accountLine}
        </span>
        {footer}
      </div>
    </aside>
  );
}

/** Phone bottom tabs + the More sheet (§3.2). Hidden from md up. */
export function PortalTabBar({
  role,
  active,
  badges,
  moreFooter,
}: {
  role: Role;
  active: NavKey | null;
  badges: NavBadges;
  moreFooter?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { tabs, more } = phoneTabs(role);
  const moreActive = more.some((item) => item.key === active);
  const tabClass = (current: boolean) =>
    cn(
      "relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
      current ? "text-foreground" : "text-muted-foreground",
    );

  return (
    <>
      {open ? (
        <div
          role="dialog"
          aria-label="More"
          data-testid="portal-more"
          className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px))] z-40 flex flex-col gap-1 rounded-t-2xl bg-card px-4 pt-3 pb-4 ring-1 ring-foreground/10 md:hidden"
        >
          {more.map((item) => {
            const Icon = ICONS[item.key];
            return (
              <Link
                key={item.key}
                href={item.href}
                onClick={() => setOpen(false)}
                aria-current={active === item.key ? "page" : undefined}
                className="flex h-13 items-center gap-3 rounded-lg px-2 text-base outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Icon aria-hidden className="size-5" />
                {item.label}
              </Link>
            );
          })}
          {moreFooter}
        </div>
      ) : null}
      <nav
        aria-label="Portal"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-foreground/10 bg-card pb-[env(safe-area-inset-bottom,0px)] md:hidden"
      >
        {tabs.map((item) => {
          const Icon = ICONS[item.key];
          return (
            <Link
              key={item.key}
              href={item.href}
              data-nav={item.key}
              aria-current={active === item.key ? "page" : undefined}
              className={tabClass(active === item.key)}
            >
              <Badge badge={badges[item.key]} className="absolute top-1.5 left-[calc(50%+4px)]" />
              <Icon aria-hidden className="size-5" />
              {item.label}
            </Link>
          );
        })}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={tabClass(moreActive || open)}
        >
          <MoreHorizontal aria-hidden className="size-5" />
          More
        </button>
      </nav>
    </>
  );
}
