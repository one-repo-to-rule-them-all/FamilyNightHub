import { afterEach, describe, expect, it, vi } from "vitest";

import type { PersonTile } from "./api";
import {
  activeTab,
  arrivalTarget,
  coldOpenTarget,
  countdownAnnouncement,
  handoffLine,
  HOME_COPY,
  isNewNight,
  isOwnNightPath,
  NEW_NIGHT_WINDOW_MS,
  nightHref,
  pastNightKind,
  readSeenNight,
  readStayNight,
  readWrapNight,
  stillToVote,
  toastTitle,
  toastVisible,
  tonightState,
  withinNewWindow,
  writeSeenNight,
  writeStayNight,
  writeWrapNight,
} from "./home";

function tile(overrides: Partial<PersonTile> = {}): PersonTile {
  return {
    id: "p1",
    name: "RooDog",
    avatar_emoji: "🦊",
    color: "#3b82f6",
    is_guest: false,
    binding: "mine",
    has_pin: true,
    locked: false,
    current: true,
    can_rename: true,
    pin_reset: null,
    ...overrides,
  };
}

const me = tile();
const sib = tile({ id: "p2", name: "Bea", current: false });

describe("tonightState (§5 H1)", () => {
  it("T0 with no live night and nothing to rate: no primary (waiting)", () => {
    expect(tonightState({ people: [me] })).toEqual({ state: "T0", primary: null });
    expect(tonightState({ people: [me], rateOwed: null })).toEqual({ state: "T0", primary: null });
  });

  it("T7 instead of T0 while a rating is owed", () => {
    expect(tonightState({ people: [me], rateOwed: { sessionId: "old" } })).toEqual({
      state: "T7",
      primary: { label: "Rate it", href: "/s/old#rate" },
    });
  });

  it("treats a closed 'live' night as no live night", () => {
    expect(tonightState({ night: { id: "n1", status: "closed" }, people: [me] }).state).toBe("T0");
  });

  it("T1 draft, T5 revealed, T6 tonight link into the night", () => {
    expect(tonightState({ night: { id: "n1", status: "draft" }, people: [me] })).toEqual({
      state: "T1",
      primary: { label: "Open movie night", href: "/s/n1" },
    });
    expect(tonightState({ night: { id: "n1", status: "revealed" }, people: [me] })).toEqual({
      state: "T5",
      primary: { label: "See the winner", href: "/s/n1" },
    });
    expect(tonightState({ night: { id: "n1", status: "tonight" }, people: [me] })).toEqual({
      state: "T6",
      primary: { label: "Add photos", href: "/s/n1" },
    });
  });

  const voting = { id: "n1", status: "voting" as const };

  it("T2 while this person hasn't voted (ballots still loading count as none)", () => {
    const vote = { state: "T2", primary: { label: "Vote now", href: "/s/n1" } };
    expect(tonightState({ night: voting, people: [me] })).toEqual(vote);
    expect(tonightState({ night: voting, people: [me], myBallots: [{ person_id: "p2" }] })).toEqual(
      vote,
    );
  });

  it("T2 when nobody is current yet", () => {
    expect(tonightState({ night: voting, people: [tile({ current: false })] }).state).toBe("T2");
  });

  it("T3 when someone else on this phone still has to vote: the switch sheet", () => {
    expect(
      tonightState({ night: voting, people: [me, sib], myBallots: [{ person_id: "p1" }] }),
    ).toEqual({ state: "T3", primary: { label: "Pass to next person", action: "switch" } });
  });

  it("T4 when everyone on this phone voted: waiting, no primary", () => {
    expect(
      tonightState({
        night: voting,
        people: [me, sib],
        myBallots: [{ person_id: "p1" }, { person_id: "p2" }],
      }),
    ).toEqual({ state: "T4", primary: null });
  });
});

describe("stillToVote", () => {
  it("skips the current person, people on other phones, locked people and voters", () => {
    const people = [
      me,
      sib,
      tile({ id: "p3", current: false, binding: "taken" }),
      tile({ id: "p4", current: false, locked: true }),
      tile({ id: "p5", current: false }),
    ];
    expect(stillToVote(people, new Set(["p5"]), "p1").map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("moving by itself (§3.3)", () => {
  it("rule 1: an arrival jumps into the live night, else stays Home", () => {
    expect(arrivalTarget({ id: "n1" })).toBe("/s/n1");
    expect(arrivalTarget()).toBe("/");
  });

  it("rule 2: only a first mount while voting with no ballot goes to the ballot", () => {
    const night = { id: "n1", status: "voting" as const };
    const draft = { id: "n1", status: "draft" as const };
    expect(coldOpenTarget({ firstMount: true, night, votedByCurrent: false })).toBe("/s/n1");
    expect(coldOpenTarget({ firstMount: false, night, votedByCurrent: false })).toBeNull();
    expect(coldOpenTarget({ firstMount: true, night, votedByCurrent: true })).toBeNull();
    expect(coldOpenTarget({ firstMount: true, night: draft, votedByCurrent: false })).toBeNull();
    expect(coldOpenTarget({ firstMount: true, votedByCurrent: false })).toBeNull();
  });

  it("encodes night ids into the path", () => {
    expect(nightHref("a/b")).toBe("/s/a%2Fb");
  });
});

describe("pastNightKind (§5 H3)", () => {
  it("wrap for the latest night (and while unknown), recap for older ones", () => {
    expect(pastNightKind("n1", "n1")).toBe("wrap");
    expect(pastNightKind("n1", undefined)).toBe("wrap");
    expect(pastNightKind("n1", "n2")).toBe("recap");
  });

  it("stays the wrap this tab showed while the newer night is live (AC-H3.6 Back)", () => {
    expect(pastNightKind("n1", "n2", { shownAsWrap: true, latestLive: true })).toBe("wrap");
    expect(pastNightKind("n1", "n2", { shownAsWrap: true, latestLive: false })).toBe("recap");
    expect(pastNightKind("n1", "n2", { shownAsWrap: false, latestLive: true })).toBe("recap");
  });
});

describe("what's new (§3.4)", () => {
  it("a live night this tab hasn't shown is new", () => {
    expect(isNewNight(null, "n1")).toBe(true);
    expect(isNewNight("n0", "n1")).toBe(true);
    expect(isNewNight("n1", "n1")).toBe(false);
    expect(isNewNight("n1", undefined)).toBe(false);
  });

  it("the chip lasts 10 minutes from creation", () => {
    const created = "2026-10-18T19:00:00Z";
    const t = Date.parse(created);
    expect(withinNewWindow(created, t + NEW_NIGHT_WINDOW_MS - 1)).toBe(true);
    expect(withinNewWindow(created, t + NEW_NIGHT_WINDOW_MS)).toBe(false);
    expect(withinNewWindow("not a date", t)).toBe(true);
  });
});

describe("tab memory (sessionStorage)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips the seen night and the stay night", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
    });
    expect(readSeenNight()).toBeNull();
    expect(readStayNight()).toBeNull();
    writeSeenNight("n1");
    writeStayNight("n2");
    expect(store.get("fnh.seenNight")).toBe("n1");
    expect(store.get("fnh.stayNight")).toBe("n2");
    expect(readSeenNight()).toBe("n1");
    expect(readStayNight()).toBe("n2");
    expect(readWrapNight()).toBeNull();
    writeWrapNight("n3");
    expect(store.get("fnh.wrapNight")).toBe("n3");
    expect(readWrapNight()).toBe("n3");
  });

  it("does nothing on the server", () => {
    expect(readSeenNight()).toBeNull();
    writeSeenNight("n1");
    expect(readSeenNight()).toBeNull();
  });

  it("survives storage that throws on access", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(readStayNight()).toBeNull();
    writeStayNight("n1");
  });

  it("survives storage whose calls throw", () => {
    const boom = () => {
      throw new Error("quota");
    };
    vi.stubGlobal("window", { sessionStorage: { getItem: boom, setItem: boom } });
    expect(readSeenNight()).toBeNull();
    writeSeenNight("n1");
  });
});

describe("the shell (§5 H0)", () => {
  it("maps pathnames to tabs", () => {
    expect(activeTab("/")).toBe("home");
    expect(activeTab("/s/n1")).toBe("home");
    expect(activeTab("/albums/n1")).toBe("home");
    expect(activeTab("/history")).toBe("history");
    expect(activeTab("/history/x")).toBe("history");
    expect(activeTab("/people/p1")).toBe("history");
    expect(activeTab("/me")).toBe("me");
    expect(activeTab("/me/pin")).toBe("me");
    expect(activeTab("/who")).toBeNull();
  });

  it("knows a night's own screens", () => {
    expect(isOwnNightPath("/s/n1", "n1")).toBe(true);
    expect(isOwnNightPath("/s/n1/x", "n1")).toBe(true);
    expect(isOwnNightPath("/s/n10", "n1")).toBe(false);
    expect(isOwnNightPath("/history", "n1")).toBe(false);
  });

  it("says what the live night is doing", () => {
    expect(handoffLine("draft")).toBe(HOME_COPY.handoff.draft);
    expect(handoffLine("voting")).toBe(HOME_COPY.handoff.voting);
    expect(handoffLine("revealed")).toBe(HOME_COPY.handoff.revealed);
    expect(handoffLine("tonight")).toBe(HOME_COPY.handoff.tonight);
  });

  it("titles the toast with the night's name, else tonight's winner once it is in", () => {
    const winner = { title: "Coco", poster_path: null } as never;
    expect(toastTitle({ status: "draft", title: "Spooky", winner: null })).toBe("Spooky");
    expect(toastTitle({ status: "voting", title: null, winner })).toBeNull();
    expect(toastTitle({ status: "revealed", title: null, winner })).toBe("Coco");
    expect(toastTitle({ status: "tonight", title: null, winner })).toBe("Coco");
    expect(toastTitle({ status: "tonight", title: null, winner: null })).toBeNull();
  });

  it("shows the toast for a new or already-counting night, never on its own screens", () => {
    const base = {
      pathname: "/history",
      nightId: "n2",
      isNew: true,
      stayed: false,
      counting: false,
    };
    expect(toastVisible(base)).toBe(true);
    expect(toastVisible({ ...base, nightId: undefined })).toBe(false);
    expect(toastVisible({ ...base, isNew: false })).toBe(false);
    expect(toastVisible({ ...base, isNew: false, counting: true })).toBe(true);
    expect(toastVisible({ ...base, stayed: true, counting: true })).toBe(false);
    expect(toastVisible({ ...base, pathname: "/s/n2" })).toBe(false);
    expect(toastVisible({ ...base, pathname: "/" })).toBe(true);
  });

  it("announces the countdown at 60, 30 and 10 s and once on pause", () => {
    const at = (seconds: number) => countdownAnnouncement("x", { seconds, paused: false });
    expect(at(60)).toBe("Taking you there in 60s");
    expect(at(59)).toBe("x");
    expect(at(30)).toBe("Taking you there in 30s");
    expect(at(10)).toBe("Taking you there in 10s");
    expect(countdownAnnouncement("x", { seconds: 42, paused: true })).toBe(
      "Paused while you finish up",
    );
  });

  it("has the copy deck's parametrised strings", () => {
    expect(HOME_COPY.bar.switch("RooDog")).toBe("Switch person, now RooDog");
    expect(HOME_COPY.t1.body(3)).toBe("The host is picking movies (3 so far).");
    expect(HOME_COPY.badge.rated(4)).toBe("You rated ★4");
    expect(HOME_COPY.me.shared("Bea, Cy")).toBe("Also on this phone: Bea, Cy");
  });
});
