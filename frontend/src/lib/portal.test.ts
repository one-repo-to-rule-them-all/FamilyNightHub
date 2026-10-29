import { describe, expect, it } from "vitest";

import {
  activeNav,
  ago,
  badgeLabel,
  buildInbox,
  claimId,
  greeting,
  inboxIsUrgent,
  inboxPreview,
  isAlreadyDone,
  isUnrated,
  navFor,
  parseHidden,
  pastNights,
  peopleBadge,
  phoneTabs,
  type PastNightLike,
  ratingLine,
  resetPlan,
  type ResetRow,
  splitActive,
  stats,
  toggleHidden,
  upNextState,
  withoutResolved,
} from "./portal";

const NOW = Date.parse("2026-10-17T20:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const night = (id: string, status: PastNightLike["status"], created: string) => ({
  id,
  status,
  title: null,
  created_at: created,
});
const past = (over: Partial<PastNightLike> & { id: string }): PastNightLike => ({
  status: "closed",
  title: null,
  created_at: hoursAgo(48),
  closed_at: hoursAgo(44),
  turnout: 5,
  rating: { count: 2, average: 4 },
  winner: { title: "Moana 2" },
  ...over,
});
const claim = (person: string, at: string) => ({
  device_id: "d1",
  device_label: "Pixel",
  person_id: person,
  person_name: person,
  avatar_emoji: "🐶",
  requested_at: at,
});
const reset = (id: string, person: string, status: "open" | "dismissed" = "open") => ({
  id,
  person_id: person,
  person_name: person,
  avatar_emoji: "🦖",
  person_locked: true,
  device_label: null,
  requested_at: hoursAgo(1),
  status,
});
const person = (id: string, locked?: boolean) => ({
  id,
  name: id,
  avatar_emoji: "🦄",
  color: "#ec4899",
  locked,
});

describe("nav", () => {
  it("filters by role", () => {
    expect(navFor("admin").map((i) => i.key)).toEqual([
      "home",
      "people",
      "phones",
      "library",
      "history",
      "settings",
    ]);
    expect(navFor("host").map((i) => i.key)).toEqual(["home", "history", "settings"]);
  });

  it("splits phone tabs and More", () => {
    const admin = phoneTabs("admin");
    expect(admin.tabs.map((i) => i.key)).toEqual(["home", "people", "library", "history"]);
    expect(admin.more.map((i) => i.key)).toEqual(["phones", "settings"]);
    expect(phoneTabs("host").more.map((i) => i.key)).toEqual(["settings"]);
  });

  it("maps a pathname to its item", () => {
    expect(activeNav("/host")).toBe("home");
    expect(activeNav("/host/abc")).toBe("home");
    expect(activeNav("/admin/people")).toBe("people");
    expect(activeNav("/admin/devices/x")).toBe("phones");
    expect(activeNav("/tv")).toBeNull();
  });
});

describe("up next", () => {
  it("follows the newest active night", () => {
    const { current, others } = splitActive([
      night("old", "voting", hoursAgo(30)),
      night("closed", "closed", hoursAgo(1)),
      night("new", "draft", hoursAgo(2)),
    ]);
    expect(current?.id).toBe("new");
    expect(others.map((n) => n.id)).toEqual(["old"]);
    expect(splitActive([]).current).toBeNull();
  });

  it("picks one state per night status", () => {
    const d = night("n", "draft", hoursAgo(1));
    expect(upNextState(null)).toEqual({ kind: "none" });
    expect(upNextState(d, { createdId: "n" })).toEqual({ kind: "created", nightId: "n" });
    expect(upNextState(d)).toEqual({ kind: "draft", nightId: "n", ready: false });
    expect(upNextState(d, { optionCount: 2 })).toEqual({
      kind: "draft",
      nightId: "n",
      ready: true,
    });
    expect(upNextState({ ...d, status: "voting" })).toEqual({ kind: "voting", nightId: "n" });
    expect(upNextState({ ...d, status: "revealed" }).kind).toBe("tonight");
    expect(upNextState({ ...d, status: "tonight" }).kind).toBe("tonight");
  });
});

describe("inbox", () => {
  const sources = {
    now: NOW,
    claims: [claim("roo", hoursAgo(0.1)), claim("sofi", hoursAgo(0.05))],
    pinResets: [reset("r1", "mateo"), reset("r2", "x", "dismissed")],
    people: [person("mateo", true), person("abuela", true), person("ok", false), person("new")],
    activeNights: [night("stale", "voting", hoursAgo(20)), night("fresh", "draft", hoursAgo(1))],
    pastNights: [
      past({ id: "unrated" }),
      past({ id: "rated", rating: { count: 5, average: 4 } }),
      past({ id: "hidden" }),
    ],
    hiddenUnrated: ["hidden"],
  };

  it("orders an admin's items by priority, newest first within a kind", () => {
    const items = buildInbox({ ...sources, role: "admin" });
    expect(items.map((i) => i.id)).toEqual([
      "reset:r1",
      claimId({ device_id: "d1", person_id: "sofi" }),
      claimId({ device_id: "d1", person_id: "roo" }),
      "locked:abuela",
      "stale:stale",
      "unrated:unrated",
    ]);
    expect(peopleBadge(items)).toBe(2);
    expect(inboxIsUrgent(items)).toBe(true);
  });

  it("never gives a host PIN resets or locked profiles", () => {
    const items = buildInbox({ ...sources, role: "host" });
    expect(items.map((i) => i.kind)).toEqual(["claim", "claim", "stale-night", "unrated"]);
    expect(peopleBadge(items)).toBe(0);
  });

  it("is empty with no sources, and not urgent without claims or resets", () => {
    expect(buildInbox({ role: "admin", now: NOW })).toEqual([]);
    const quiet = buildInbox({ role: "admin", now: NOW, pastNights: [past({ id: "u" })] });
    expect(inboxIsUrgent(quiet)).toBe(false);
  });

  it("previews five unless all are shown", () => {
    const many = buildInbox({
      role: "host",
      now: NOW,
      claims: Array.from({ length: 7 }, (_, i) => claim(`p${i}`, hoursAgo(i))),
    });
    expect(inboxPreview(many, false)).toHaveLength(5);
    expect(inboxPreview(many, true)).toHaveLength(7);
  });

  it("decides what counts as unrated", () => {
    expect(isUnrated(past({ id: "a" }), NOW)).toBe(true);
    expect(isUnrated(past({ id: "a", rating: null }), NOW)).toBe(true);
    expect(isUnrated(past({ id: "a", status: "tonight" }), NOW)).toBe(false);
    expect(isUnrated(past({ id: "a", closed_at: null }), NOW)).toBe(false);
    expect(isUnrated(past({ id: "a", turnout: 0 }), NOW)).toBe(false);
    expect(isUnrated(past({ id: "a", closed_at: hoursAgo(15 * 24) }), NOW)).toBe(false);
  });

  // #88: a locked row resets directly; a request row still approves the phone's request.
  it("plans a Reset PIN for request rows and locked rows", () => {
    const items = buildInbox({ ...sources, role: "admin" });
    const rows = items.filter((i): i is ResetRow => i.kind === "pin-reset" || i.kind === "locked");
    expect(rows.map(resetPlan)).toEqual([
      {
        rowId: "reset:r1",
        name: "mateo",
        note: "Their old PIN stops working. They'll choose a new one on the phone that asked.",
        via: "request",
        requestId: "r1",
      },
      {
        rowId: "locked:abuela",
        name: "abuela",
        note: "Their old PIN stops working. They'll choose a new one on their phone.",
        via: "direct",
        personId: "abuela",
      },
    ]);
  });

  it("toggles and parses the hidden list", () => {
    expect(toggleHidden(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleHidden(["a", "b"], "a")).toEqual(["b"]);
    expect(parseHidden(null)).toEqual([]);
    expect(parseHidden("not json")).toEqual([]);
    expect(parseHidden('{"a":1}')).toEqual([]);
    expect(parseHidden('["a",2,"b"]')).toEqual(["a", "b"]);
  });
});

describe("stats", () => {
  it("summarises the recent nights", () => {
    const nights = [
      past({ id: "a", created_at: "2026-10-16T01:00:00Z", turnout: 6 }),
      past({ id: "b", created_at: "2026-10-09T01:00:00Z", turnout: 4 }),
      past({ id: "c", created_at: "2026-09-20T01:00:00Z", turnout: 3 }),
    ];
    const s = stats(nights, new Date("2026-10-17T12:00:00"));
    expect(s.last?.id).toBe("a");
    expect(s.thisMonth).toBe(2);
    expect(s.turnout).toEqual([3, 4, 6]);
  });

  it("hides the trend under two nights", () => {
    expect(stats([past({ id: "a" })], new Date(NOW)).turnout).toEqual([]);
    expect(stats([], new Date(NOW))).toEqual({ last: null, thisMonth: 0, turnout: [] });
  });

  it("caps the series at eight", () => {
    const nights = Array.from({ length: 10 }, (_, i) =>
      past({ id: `n${i}`, created_at: hoursAgo(i * 24 + 1), turnout: i }),
    );
    expect(stats(nights, new Date(NOW)).turnout).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it("formats the rating", () => {
    expect(ratingLine(null)).toBeNull();
    expect(ratingLine({ count: 0, average: null })).toBeNull();
    expect(ratingLine({ count: 2, average: null })).toBeNull();
    expect(ratingLine({ count: 3, average: 4.333 })).toBe("4.3 from 3");
  });
});

describe("copy", () => {
  it("greets by part of day and first name", () => {
    expect(greeting("Rodolfo Baez", new Date(2026, 9, 17, 9))).toBe("Good morning, Rodolfo");
    expect(greeting("Ana", new Date(2026, 9, 17, 14))).toBe("Good afternoon, Ana");
    expect(greeting("  ", new Date(2026, 9, 17, 20))).toBe("Good evening,   ");
  });

  it("says how long ago", () => {
    expect(ago(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
    expect(ago(new Date(NOW + 10_000).toISOString(), NOW)).toBe("just now");
    expect(ago(hoursAgo(0.5), NOW)).toBe("30 min ago");
    expect(ago(hoursAgo(3), NOW)).toBe("3 h ago");
    expect(ago(hoursAgo(24), NOW)).toBe("1 day ago");
    expect(ago(hoursAgo(72), NOW)).toBe("3 days ago");
  });
});

describe("dashboard wiring", () => {
  it("keeps only nights with a winner", () => {
    const nights = [
      night("d", "draft", hoursAgo(1)),
      night("v", "voting", hoursAgo(2)),
      night("r", "revealed", hoursAgo(3)),
      night("t", "tonight", hoursAgo(4)),
      night("c", "closed", hoursAgo(5)),
    ];
    expect(pastNights(nights).map((n) => n.id)).toEqual(["r", "t", "c"]);
  });

  it("treats 404 and 409 as already done", () => {
    expect(isAlreadyDone({ status: 404 })).toBe(true);
    expect(isAlreadyDone({ status: 409 })).toBe(true);
    expect(isAlreadyDone({ status: 500 })).toBe(false);
    expect(isAlreadyDone(null)).toBe(false);
    expect(isAlreadyDone(undefined)).toBe(false);
  });

  it("drops rows resolved here", () => {
    const items = buildInbox({
      role: "host",
      now: NOW,
      claims: [
        {
          device_id: "d1",
          device_label: null,
          person_id: "p1",
          person_name: "Ana",
          avatar_emoji: "🦊",
          requested_at: hoursAgo(1),
        },
        {
          device_id: "d2",
          device_label: null,
          person_id: "p2",
          person_name: "Ben",
          avatar_emoji: "🐻",
          requested_at: hoursAgo(2),
        },
      ],
    });
    expect(withoutResolved(items, new Set())).toBe(items);
    expect(withoutResolved(items, new Set(["claim:d1:p1"])).map((i) => i.id)).toEqual([
      "claim:d2:p2",
    ]);
  });

  it("labels the badge", () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(1)).toBe("1 thing needs you");
    expect(badgeLabel(3)).toBe("3 things need you");
  });
});
