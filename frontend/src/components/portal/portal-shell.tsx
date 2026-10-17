"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import {
  type Account,
  type AdminPerson,
  type ApiError,
  type Claim,
  type NightSummary,
  type PinReset,
  api,
} from "@/lib/api";
import {
  ACTIVE_STATUSES,
  activeNav,
  buildInbox,
  navFor,
  parseHidden,
  type Role,
} from "@/lib/portal";
import {
  BADGE_POLL_MS,
  HIDDEN_UNRATED_KEY,
  accountLine,
  navBadges,
  pastNights,
} from "@/lib/portal-shell";

import { PortalSidebar, PortalTabBar } from "./portal-nav";

function readHiddenRaw(): string | null {
  try {
    return window.localStorage.getItem(HIDDEN_UNRATED_KEY);
  } catch {
    return null; // Private mode or blocked storage: nothing is hidden.
  }
}

function subscribeStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** Home's hidden-unrated list; Home signals same-tab changes with a synthetic `storage` event. */
function useHiddenUnrated(): string[] {
  const raw = useSyncExternalStore(subscribeStorage, readHiddenRaw, () => null);
  return useMemo(() => parseHidden(raw), [raw]);
}

/** Ticks every 30 s so the stale/unrated thresholds stay current (as Home does). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * The nav badges (§3.2), from the same queries as Home's inbox (§6: same keys and fetchers, so
 * no extra requests). The admin-only sources are never sent for a host (AC-P2.2).
 */
function useBadges(role: Role | null) {
  const admin = role === "admin";
  const signedIn = role !== null;
  const now = useNow();
  const hidden = useHiddenUnrated();

  const active = useQuery<NightSummary[], ApiError>({
    queryKey: ["nights", "active"],
    queryFn: () => api.nights({ status: [...ACTIVE_STATUSES] }),
    enabled: signedIn,
    refetchInterval: BADGE_POLL_MS,
  });
  const recent = useQuery<NightSummary[], ApiError>({
    queryKey: ["nights", "recent"],
    queryFn: () => api.nights({ limit: 8 }),
    enabled: signedIn,
  });
  const claims = useQuery<Claim[], ApiError>({
    queryKey: ["claims"],
    queryFn: api.claims,
    enabled: signedIn,
    refetchInterval: BADGE_POLL_MS,
  });
  const pinResets = useQuery<PinReset[], ApiError>({
    queryKey: ["admin", "pin-resets"],
    queryFn: api.pinResets,
    enabled: admin,
    refetchInterval: BADGE_POLL_MS,
  });
  const people = useQuery<AdminPerson[], ApiError>({
    queryKey: ["admin", "people"],
    queryFn: api.adminPeople,
    enabled: admin,
  });

  if (!role) return {};
  return navBadges(
    buildInbox({
      role,
      now,
      claims: claims.data,
      pinResets: pinResets.data,
      people: people.data,
      activeNights: active.data,
      pastNights: pastNights(recent.data ?? []),
      hiddenUnrated: hidden,
    }),
  );
}

function SignOut({ className }: { className?: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const logout = useMutation<void, ApiError>({
    mutationFn: api.logout,
    onSuccess: () => {
      router.replace("/login");
      queryClient.removeQueries();
    },
  });
  return (
    <div className={className}>
      <ApiErrorNotice error={logout.error} />
      <Button
        variant="ghost"
        size="lg"
        className="w-full justify-start"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
        data-testid="sign-out"
      >
        <LogOut aria-hidden />
        Sign out
      </Button>
    </div>
  );
}

/**
 * One shell for every `/host` and `/admin` screen (proposals/owner-portal.md §3): a sidebar from
 * md up, a top bar and bottom tabs (+ More) below. The nav is filtered by the account's role; that
 * gate is UX only, the API stays the boundary. A signed-out browser goes to /login.
 */
export function PortalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const me = useQuery<Account, ApiError>({ queryKey: ["me"], queryFn: api.me });
  const signedOut = me.error?.status === 401;
  const role = me.data?.role ?? null;
  const badges = useBadges(role);
  const active = activeNav(pathname);

  useEffect(() => {
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  return (
    <div className="flex min-h-dvh w-full flex-1">
      {me.data ? (
        <PortalSidebar
          items={navFor(me.data.role)}
          active={active}
          badges={badges}
          householdName={me.data.household_name}
          accountLine={accountLine(me.data)}
          footer={<SignOut className="-mx-2.5 flex flex-col gap-2" />}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-foreground/10 px-4 md:hidden">
          <span className="truncate font-heading font-semibold">
            {me.data?.household_name ?? "Family Night"}
          </span>
          {me.data ? (
            <span className="truncate text-sm text-muted-foreground">{accountLine(me.data)}</span>
          ) : null}
        </header>
        <main className="flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-6 pb-[calc(5rem+env(safe-area-inset-bottom,0px))] sm:px-6 md:px-8 md:pb-8">
          {children}
        </main>
      </div>
      {me.data ? (
        <PortalTabBar
          role={me.data.role}
          active={active}
          badges={badges}
          moreFooter={<SignOut className="mt-1 border-t border-foreground/10 pt-2" />}
        />
      ) : null}
    </div>
  );
}
