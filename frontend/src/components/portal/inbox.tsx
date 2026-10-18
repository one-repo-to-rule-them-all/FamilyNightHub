"use client";

import { CheckCircle2, Clock, Lock, Star } from "lucide-react";
import { useState } from "react";

import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { ago, type InboxItem, inboxPreview } from "@/lib/portal";

/** What each row's buttons do; the dashboard wires them to mutations. */
export type InboxActions = {
  approveClaim: (item: Extract<InboxItem, { kind: "claim" }>) => void;
  rejectClaim: (item: Extract<InboxItem, { kind: "claim" }>) => void;
  resetPin: (item: Extract<InboxItem, { kind: "pin-reset" }>) => void;
  dismissReset: (item: Extract<InboxItem, { kind: "pin-reset" }>) => void;
  seeProfile: (personId: string) => void;
  endNight: (nightId: string) => void;
  openNight: (nightId: string) => void;
  hideUnrated: (nightId: string) => void;
};

/** The attention inbox (§5 P2). Row actions are `secondary`/`ghost`: the page's primary is Up next. */
export function Inbox({
  items,
  actions,
  busyId,
  now,
  notices,
}: {
  items: InboxItem[];
  actions: InboxActions;
  /** The row whose action is in flight. */
  busyId?: string | null;
  now: number;
  /** One muted line per source that failed to load. */
  notices?: string[];
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = inboxPreview(items, showAll);

  return (
    <section aria-labelledby="inbox-title" data-testid="inbox" className="flex flex-col gap-3">
      <h2
        id="inbox-title"
        className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
      >
        Needs you
      </h2>
      {notices?.map((notice) => (
        <p key={notice} className="text-sm text-muted-foreground">
          {notice}
        </p>
      ))}
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-muted-foreground" data-testid="inbox-empty">
          <CheckCircle2 aria-hidden className="size-4.5" />
          All clear. Nothing needs you right now.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-foreground/10">
          {shown.map((item) => (
            <li
              key={item.id}
              data-inbox-kind={item.kind}
              data-inbox-id={item.id}
              className="flex items-start gap-3 py-3.5 first:pt-0.5"
            >
              <Row item={item} actions={actions} busy={busyId === item.id} now={now} />
            </li>
          ))}
        </ul>
      )}
      {items.length > shown.length || showAll ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show fewer" : `Show all (${items.length})`}
        </Button>
      ) : null}
    </section>
  );
}

function Row({
  item,
  actions,
  busy,
  now,
}: {
  item: InboxItem;
  actions: InboxActions;
  busy: boolean;
  now: number;
}) {
  const btn = (
    label: string,
    onClick: () => void,
    variant: "secondary" | "ghost" = "secondary",
    aria?: string,
  ) => (
    <Button
      variant={variant}
      size="lg"
      className="px-3.5"
      disabled={busy}
      aria-label={aria}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  const icon = (Icon: typeof Clock) => (
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
      <Icon className="size-4.5 text-muted-foreground" />
    </span>
  );

  let avatar: React.ReactNode;
  let text: React.ReactNode;
  let meta: string;
  let buttons: React.ReactNode;

  switch (item.kind) {
    case "pin-reset": {
      const r = item.reset;
      avatar = (
        <Avatar emoji={r.avatar_emoji} color="#888888" className="size-9 shrink-0 text-lg" />
      );
      text = (
        <>
          <strong>{r.person_name}</strong> forgot their PIN
          {r.person_locked ? <LockedChip /> : null}
        </>
      );
      meta = `Asked ${ago(r.requested_at, now)}${r.device_label ? ` from ${r.device_label}` : ""}`;
      buttons = (
        <>
          {btn(
            "Reset PIN",
            () => actions.resetPin(item),
            "secondary",
            `Reset PIN for ${r.person_name}`,
          )}
          {btn("Dismiss", () => actions.dismissReset(item), "ghost")}
        </>
      );
      break;
    }
    case "claim": {
      const c = item.claim;
      avatar = (
        <Avatar emoji={c.avatar_emoji} color="#888888" className="size-9 shrink-0 text-lg" />
      );
      text = (
        <>
          <strong>{c.device_label || "A phone"}</strong> wants to be{" "}
          <strong>{c.person_name}</strong>
        </>
      );
      meta = ago(c.requested_at, now);
      buttons = (
        <>
          {btn(
            "Approve",
            () => actions.approveClaim(item),
            "secondary",
            `Approve ${c.person_name}`,
          )}
          {btn("Reject", () => actions.rejectClaim(item), "ghost", `Reject ${c.person_name}`)}
        </>
      );
      break;
    }
    case "locked": {
      const p = item.person;
      avatar = (
        <Avatar emoji={p.avatar_emoji} color={p.color} className="size-9 shrink-0 text-lg" />
      );
      text = (
        <>
          <strong>{p.name}</strong> is locked out after 5 wrong PINs
        </>
      );
      meta = `They can tap "Ask the family admin" on their phone, then reset it here.`;
      buttons = btn("See profile", () => actions.seeProfile(p.id));
      break;
    }
    case "stale-night": {
      const n = item.night;
      const day = new Date(n.created_at).toLocaleDateString([], { weekday: "long" });
      avatar = icon(Clock);
      text = (
        <>
          <strong>{n.title || "Movie night"}</strong> has been open since {day}
        </>
      );
      meta = ago(n.created_at, now);
      buttons = (
        <>
          {btn("End the night", () => actions.endNight(n.id))}
          {btn("Open", () => actions.openNight(n.id), "ghost")}
        </>
      );
      break;
    }
    case "unrated": {
      const n = item.night;
      avatar = icon(Star);
      text = (
        <>
          <strong>
            {n.rating?.count ?? 0} of {n.turnout}
          </strong>{" "}
          rated <strong>{n.winner?.title ?? n.title ?? "the movie"}</strong>
        </>
      );
      meta = n.closed_at ? ago(n.closed_at, now) : "";
      buttons = (
        <>
          {btn("Open", () => actions.openNight(n.id))}
          {btn("Hide", () => actions.hideUnrated(n.id), "ghost")}
        </>
      );
      break;
    }
  }

  return (
    <>
      {avatar}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="leading-snug">{text}</p>
        {meta ? <p className="text-sm text-muted-foreground">{meta}</p> : null}
        <div className="flex flex-wrap gap-2">{buttons}</div>
      </div>
    </>
  );
}

function LockedChip() {
  return (
    <span className="ml-2 inline-flex h-5 items-center gap-1 rounded-full px-2 align-[1px] text-[11px] font-medium text-amber-300 ring-1 ring-amber-300/35">
      <Lock aria-hidden className="size-3" />
      Locked
    </span>
  );
}
