"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Inbox, type InboxActions } from "@/components/portal/inbox";
import { QuickStats } from "@/components/portal/stats";
import { UpNextCard } from "@/components/portal/up-next-card";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import {
  type Account,
  type AdminPerson,
  api,
  type ApiError,
  type Claim,
  type Night,
  type NightSummary,
  type PinReset,
} from "@/lib/api";
import {
  ACTIVE_STATUSES,
  ALREADY_DONE,
  buildInbox,
  greeting,
  HIDDEN_UNRATED_KEY,
  INBOX_POLL_MS,
  type InboxItem,
  isAlreadyDone,
  parseHidden,
  pastNights,
  splitActive,
  stats,
  toggleHidden,
  withoutResolved,
} from "@/lib/portal";

import { PIN_RESETS_KEY } from "@/app/admin/people/pin-requests";

import { STATUS_LABEL } from "./status";

type ResetItem = Extract<InboxItem, { kind: "pin-reset" }>;

function readHidden(): string[] {
  try {
    return parseHidden(window.localStorage.getItem(HIDDEN_UNRATED_KEY));
  } catch {
    return [];
  }
}

function writeHidden(ids: string[]) {
  try {
    window.localStorage.setItem(HIDDEN_UNRATED_KEY, JSON.stringify(ids));
    // A same-tab write fires no storage event; the shell's Home badge listens for this one.
    window.dispatchEvent(new StorageEvent("storage", { key: HIDDEN_UNRATED_KEY }));
  } catch {
    // Private mode or blocked storage: the row is hidden for this visit only.
  }
}

/** Ticks every 30 s so "4 min ago" and the stale/unrated thresholds stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Home (proposals/owner-portal.md §5 P1): Up next, Needs you, At a glance, Also running. */
export function HostHome() {
  const router = useRouter();
  const me = useQuery<Account, ApiError>({ queryKey: ["me"], queryFn: api.me });
  const signedOut = me.error?.status === 401;

  useEffect(() => {
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  if (me.isPending || signedOut) {
    return <p className="text-lg text-muted-foreground">Loading…</p>;
  }
  if (me.isError) return <ApiErrorNotice error={me.error} />;
  return <Dashboard me={me.data} />;
}

function Dashboard({ me }: { me: Account }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const admin = me.role === "admin";
  const now = useNow();

  // §6: existing keys are reused so People, the night page and the nav badge stay in sync.
  const active = useQuery<NightSummary[], ApiError>({
    queryKey: ["nights", "active"],
    queryFn: () => api.nights({ status: [...ACTIVE_STATUSES] }),
    refetchInterval: INBOX_POLL_MS,
  });
  const recent = useQuery<NightSummary[], ApiError>({
    queryKey: ["nights", "recent"],
    queryFn: () => api.nights({ limit: 8 }),
  });
  const claims = useQuery<Claim[], ApiError>({
    queryKey: ["claims"],
    queryFn: api.claims,
    refetchInterval: INBOX_POLL_MS,
  });
  // Hosts never send the admin-only queries (AC-P2.2).
  const pinResets = useQuery<PinReset[], ApiError>({
    queryKey: PIN_RESETS_KEY,
    queryFn: api.pinResets,
    enabled: admin,
    refetchInterval: INBOX_POLL_MS,
  });
  const people = useQuery<AdminPerson[], ApiError>({
    queryKey: ["admin", "people"],
    queryFn: api.adminPeople,
    enabled: admin,
  });

  // Dashboard renders only after `["me"]` resolves, i.e. on the client, so storage is readable.
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<ResetItem | null>(null);
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);

  const { current, others } = splitActive(active.data ?? []);
  const past = pastNights(recent.data ?? []);
  const items = withoutResolved(
    buildInbox({
      role: me.role,
      now,
      claims: claims.data,
      pinResets: pinResets.data,
      people: people.data,
      activeNights: active.data,
      pastNights: past,
      hiddenUnrated: hidden,
    }),
    resolved,
  );

  const notices = [
    notice,
    claims.isError ? "Couldn't load phone requests." : null,
    pinResets.isError ? "Couldn't load PIN requests." : null,
    people.isError ? "Couldn't load locked profiles." : null,
    active.isError || recent.isError ? "Couldn't load your nights." : null,
  ].filter((line): line is string => line !== null);

  /** Optimistically drops the row; on failure it comes back, unless someone else resolved it. */
  const resolveRow = <T,>(id: string, run: () => Promise<T>, sources: readonly unknown[][]) => {
    setNotice(null);
    setResolved((set) => new Set(set).add(id));
    run()
      .catch((error: ApiError) => {
        setNotice(isAlreadyDone(error) ? ALREADY_DONE : error.message);
      })
      .finally(() => {
        void Promise.all(
          sources.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        ).then(() =>
          setResolved((set) => {
            const next = new Set(set);
            next.delete(id);
            return next;
          }),
        );
      });
  };

  const decideClaim = (item: Extract<InboxItem, { kind: "claim" }>, approve: boolean) =>
    resolveRow(
      item.id,
      () =>
        approve
          ? api.approveClaim(item.claim.device_id, item.claim.person_id)
          : api.rejectClaim(item.claim.device_id, item.claim.person_id),
      [["claims"]],
    );

  const actions: InboxActions = {
    approveClaim: (item) => decideClaim(item, true),
    rejectClaim: (item) => decideClaim(item, false),
    resetPin: (item) => setConfirmReset(item),
    dismissReset: (item) =>
      resolveRow(item.id, () => api.dismissPinReset(item.reset.id), [
        [...PIN_RESETS_KEY],
        ["admin", "people"],
      ]),
    seeProfile: (personId) => router.push(`/admin/people#person-${personId}`),
    endNight: (nightId) => setConfirmEnd(nightId),
    openNight: (nightId) => router.push(`/host/${nightId}`),
    hideUnrated: (nightId) => {
      const next = toggleHidden(hidden, nightId);
      setHidden(next);
      writeHidden(next);
    },
  };

  const close = useMutation<Night, ApiError, string>({
    mutationFn: (nightId) => api.closeNight(nightId),
    onSuccess: () => {
      setConfirmEnd(null);
      void queryClient.invalidateQueries({ queryKey: ["nights"] });
    },
    onError: (error) => {
      if (!isAlreadyDone(error)) return;
      setConfirmEnd(null);
      setNotice(ALREADY_DONE);
      void queryClient.invalidateQueries({ queryKey: ["nights"] });
    },
  });

  const lastNight = past[0] ?? null;

  return (
    <div data-screen="portal-home" className="flex flex-col gap-8">
      <p className="text-lg" data-testid="signed-in-as">
        {greeting(me.display_name, new Date(now))}
        <span className="text-muted-foreground"> · {me.household_name}</span>
      </p>

      <div className="grid gap-8 xl:grid-cols-5">
        <div className="xl:col-span-3">
          {active.isPending ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <UpNextCard current={current} lastNight={lastNight} />
          )}
        </div>
        <div className="xl:col-span-2">
          <Inbox items={items} actions={actions} now={now} notices={notices} />
        </div>
      </div>

      <QuickStats stats={stats(past, new Date(now))} lastHref={(id) => `/host/${id}`} />

      {others.length > 0 ? <AlsoRunning nights={others} /> : null}

      {confirmReset ? (
        <ModalDialog
          title={
            <>
              Reset <strong>{confirmReset.reset.person_name}</strong>&apos;s PIN?
            </>
          }
          onClose={() => setConfirmReset(null)}
          testId="reset-pin-confirm"
        >
          <p className="text-sm">
            Their old PIN stops working. They&apos;ll choose a new one on the phone that asked.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              className="px-4"
              onClick={() => {
                const item = confirmReset;
                setConfirmReset(null);
                resolveRow(item.id, () => api.approvePinReset(item.reset.id), [
                  [...PIN_RESETS_KEY],
                  ["admin", "people"],
                ]);
              }}
            >
              Reset PIN
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="px-4"
              onClick={() => setConfirmReset(null)}
            >
              Cancel
            </Button>
          </div>
        </ModalDialog>
      ) : null}

      {confirmEnd ? (
        <ModalDialog
          title="End the night?"
          onClose={() => setConfirmEnd(null)}
          testId="end-night-confirm"
        >
          <p className="text-sm">
            Phones stop joining with tonight&apos;s code. Photos and ratings stay open.
          </p>
          {isAlreadyDone(close.error) ? null : <ApiErrorNotice error={close.error} />}
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              className="px-4"
              disabled={close.isPending}
              onClick={() => close.mutate(confirmEnd)}
            >
              {close.isPending ? "Ending…" : "End the night"}
            </Button>
            <Button variant="ghost" size="lg" className="px-4" onClick={() => setConfirmEnd(null)}>
              Cancel
            </Button>
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
}

/** §5 P1 item 5: the other active nights, when more than one is running. */
function AlsoRunning({ nights }: { nights: NightSummary[] }) {
  return (
    <section aria-labelledby="also-running" className="flex flex-col gap-3">
      <h2
        id="also-running"
        className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
      >
        Also running
      </h2>
      <ul className="flex flex-col gap-2">
        {nights.map((night) => (
          <li key={night.id}>
            <Link
              href={`/host/${night.id}`}
              className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-card px-4 py-2.5 ring-1 ring-foreground/10 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="flex flex-col">
                <span className="font-medium">{night.title || "Movie night"}</span>
                <span className="text-sm text-muted-foreground">
                  {STATUS_LABEL[night.status]} · started{" "}
                  {new Date(night.created_at).toLocaleString([], {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </span>
              <ChevronRight aria-hidden className="size-5 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
