/**
 * The phone home's pure logic (proposals/guest-home.md). React-free so it is unit-tested to 100%:
 * the Tonight card's state and its one primary (§5 H1), when the phone moves by itself (§3.3
 * rules 1 and 2), which past-night screen a closed night gets (§5 H3), what counts as a new night
 * (§3.4), and the copy deck (§7).
 *
 * Inputs are structural subsets of the API types, so the shell, Home and the night screens can all
 * pass what they already hold.
 */
import type { NightStatus, NightSummary, OwnBallot, PersonTile } from "@/lib/api";
import { currentPerson } from "@/lib/who";

// ---------------------------------------------------------------------------------------------
// Copy deck (§7). Names are passed in; the components render them in bold where the deck says so.

export const HOME_COPY = {
  bar: {
    fallback: "Family Night",
    switch: (name: string) => `Switch person, now ${name}`,
  },
  nav: { home: "Home", history: "History", me: "Me", live: "Movie night is on" },
  home: { hi: "Hi," },
  new: "Just started",
  newAnnounce: "A new movie night just started.",
  t0: { title: "No movie night yet", body: "When the host starts one, it shows up right here." },
  t1: {
    title: "Movie night is starting",
    body: (n: number) => `The host is picking movies (${n} so far).`,
    button: "Open movie night",
  },
  t2: { title: "Voting is open!", button: "Vote now" },
  t3: { title: "Your picks are in", button: "Pass to next person" },
  t4: { title: "Your picks are in", change: "Change my picks" },
  t5: { title: "Tonight's movie is…", button: "See the winner" },
  t6: {
    body: "Snap the couch crew, the snacks, the screen.",
    button: "Add photos",
    rate: "Already watched? Rate it",
  },
  t7: { button: "Rate it" },
  recent: { title: "My recent nights", all: "See all my nights" },
  badge: { won: "Your pick won", rated: (n: number) => `You rated ★${n}`, rate: "Rate it" },
  empty: {
    mine: "Your movie nights will show up here after the first one.",
    family: "No movie nights yet. Tonight could be the first.",
  },
  hist: { title: "History", mine: "Mine", family: "Family" },
  handoff: {
    draft: "A new movie night is starting.",
    voting: "Voting is open for tonight's movie night!",
    revealed: "Tonight's winner is in.",
    tonight: "Tonight's movie:",
    go: "Go to tonight's movie night",
    countdown: (n: number) => `Taking you there in ${n}s`,
    paused: "Paused while you finish up",
    stay: "Stay here",
  },
  toast: {
    started: "Movie night started",
    join: "Join",
    label: "New movie night",
    setup: "Movie night is being set up",
    setupBody: "We'll tell you when voting opens.",
    ok: "OK",
  },
  wrap: { title: "That's a wrap", lede: "Thanks for movie night.", home: "Back to Home" },
  recap: {
    yours: "Your night",
    family: "The family's picks",
    who: "Who came",
    photos: "See all photos",
  },
  me: {
    picture: "Change picture",
    renameHelp: "You can change your name once. After that, ask the family admin.",
    phone: "This phone",
    switch: "Switch person",
    add: "Add someone to this phone",
    shared: (names: string) => `Also on this phone: ${names}`,
    pin: "Change my PIN",
    myNights: "See my nights",
  },
} as const;

// ---------------------------------------------------------------------------------------------
// Tonight card (§5 H1)

export type TonightState = "T0" | "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7";

export type TonightPrimary = { label: string; href: string } | { label: string; action: "switch" };

export type TonightInput = {
  /** The household's live night (`["nights","live"]`), undefined when there is none. */
  night?: Pick<NightSummary, "id" | "status">;
  /** `GET /sessions/{id}/ballots/mine` while voting; undefined (still loading) counts as none. */
  myBallots?: Pick<OwnBallot, "person_id">[];
  people: readonly PersonTile[];
  /** The newest `tonight`/`closed` night someone here hasn't rated (and "Not now" wasn't tapped). */
  rateOwed?: { sessionId: string } | null;
};

export function nightHref(id: string): string {
  return `/s/${encodeURIComponent(id)}`;
}

/** The Tonight card's state and its one primary, or null for T0/T4 (a `waiting` state). */
export function tonightState(input: TonightInput): {
  state: TonightState;
  primary: TonightPrimary | null;
} {
  const { night, rateOwed } = input;
  if (!night || night.status === "closed") {
    if (rateOwed) {
      return {
        state: "T7",
        primary: { label: HOME_COPY.t7.button, href: `${nightHref(rateOwed.sessionId)}#rate` },
      };
    }
    return { state: "T0", primary: null };
  }
  const href = nightHref(night.id);
  if (night.status === "draft") {
    return { state: "T1", primary: { label: HOME_COPY.t1.button, href } };
  }
  if (night.status === "revealed") {
    return { state: "T5", primary: { label: HOME_COPY.t5.button, href } };
  }
  if (night.status === "tonight") {
    return { state: "T6", primary: { label: HOME_COPY.t6.button, href } };
  }
  // voting
  const voted = new Set((input.myBallots ?? []).map((b) => b.person_id));
  const me = currentPerson(input.people);
  if (!me || !voted.has(me.id)) {
    return { state: "T2", primary: { label: HOME_COPY.t2.button, href } };
  }
  if (stillToVote(input.people, voted, me.id).length > 0) {
    return { state: "T3", primary: { label: HOME_COPY.t3.button, action: "switch" } };
  }
  return { state: "T4", primary: null };
}

/** Others this phone holds who can vote and haven't (T3's "{names} on this phone still need to vote"). */
export function stillToVote(
  people: readonly PersonTile[],
  voted: ReadonlySet<string>,
  currentId: string,
): PersonTile[] {
  return people.filter(
    (p) => p.binding === "mine" && p.id !== currentId && !p.locked && !voted.has(p.id),
  );
}

// ---------------------------------------------------------------------------------------------
// When the phone moves by itself (§3.3)

/** Rule 1: an arrival (`/?arrive=1`) jumps into the live night, else stays on Home. */
export function arrivalTarget(liveNight?: Pick<NightSummary, "id">): string {
  return liveNight ? nightHref(liveNight.id) : "/";
}

/**
 * Rule 2 (owner decision §11.1): the first Home mount of a page load goes straight to the ballot
 * when voting is open and the current person hasn't voted. Anything else stays on Home (null).
 */
export function coldOpenTarget(input: {
  firstMount: boolean;
  night?: { id: string; status: NightStatus };
  votedByCurrent: boolean;
}): string | null {
  const { firstMount, night, votedByCurrent } = input;
  if (firstMount && night?.status === "voting" && !votedByCurrent) return nightHref(night.id);
  return null;
}

/**
 * §5 H3: a closed night is That's a wrap when it is the household's latest night, else the recap.
 * While the latest night is unknown (loading) it stays That's a wrap, which has a way Home.
 *
 * A night this tab already showed as the wrap stays the wrap while the newer night is still live
 * (`shownAsWrap` + `latestLive`): Back after the auto-move, or after **Go**, returns to the screen
 * the guest left (AC-H3.6). Once that newer night closes, the older one is a recap.
 */
export function pastNightKind(
  nightId: string,
  latestId: string | undefined,
  { shownAsWrap = false, latestLive = false }: { shownAsWrap?: boolean; latestLive?: boolean } = {},
): "wrap" | "recap" {
  if (latestId === undefined || latestId === nightId) return "wrap";
  return shownAsWrap && latestLive ? "wrap" : "recap";
}

// ---------------------------------------------------------------------------------------------
// What's new (§3.4)

/** How long the "Just started" chip stays on a night nobody opened (§3.4). */
export const NEW_NIGHT_WINDOW_MS = 10 * 60 * 1000;

/** A live night this tab hasn't shown yet. */
export function isNewNight(seenId: string | null, liveId: string | undefined): boolean {
  return liveId !== undefined && liveId !== seenId;
}

/** Still inside the chip's 10-minute window, measured from the night's creation. */
export function withinNewWindow(createdAt: string, now: number): boolean {
  const created = Date.parse(createdAt);
  return Number.isNaN(created) || now - created < NEW_NIGHT_WINDOW_MS;
}

// ---------------------------------------------------------------------------------------------
// Tab-scoped memory (`sessionStorage`), guarded like night-code-handoff.ts

export const SEEN_NIGHT_KEY = "fnh.seenNight";
export const STAY_NIGHT_KEY = "fnh.stayNight";
export const WRAP_NIGHT_KEY = "fnh.wrapNight";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Disabled storage: the chip or the countdown just comes back on the next load.
  }
}

/** The last live night this tab has shown (drops the "Just started" chip). */
export function readSeenNight(): string | null {
  return read(SEEN_NIGHT_KEY);
}

export function writeSeenNight(id: string): void {
  write(SEEN_NIGHT_KEY, id);
}

/** The closed night this tab last showed as That's a wrap (`pastNightKind`'s `shownAsWrap`). */
export function readWrapNight(): string | null {
  return read(WRAP_NIGHT_KEY);
}

export function writeWrapNight(id: string): void {
  write(WRAP_NIGHT_KEY, id);
}

/** The night **Stay here** was tapped for: no countdown again for it in this tab (§5 H0c). */
export function readStayNight(): string | null {
  return read(STAY_NIGHT_KEY);
}

export function writeStayNight(id: string): void {
  write(STAY_NIGHT_KEY, id);
}

// ---------------------------------------------------------------------------------------------
// The shell (§5 H0)

export type GuestTab = "home" | "history" | "me";

export const GUEST_TABS: readonly { key: GuestTab; href: string; label: string }[] = [
  { key: "home", href: "/", label: HOME_COPY.nav.home },
  { key: "history", href: "/history", label: HOME_COPY.nav.history },
  { key: "me", href: "/me", label: HOME_COPY.nav.me },
];

/**
 * The tab a pathname belongs to. A night (`/s/…`) and an album count as Home (the live night lives
 * there); a person's profile counts as History, where it's reached from.
 */
export function activeTab(pathname: string): GuestTab | null {
  if (pathname === "/" || pathname.startsWith("/s/") || pathname.startsWith("/albums/")) {
    return "home";
  }
  if (pathname === "/history" || pathname.startsWith("/history/")) return "history";
  if (pathname.startsWith("/people/")) return "history";
  if (pathname === "/me" || pathname.startsWith("/me/")) return "me";
  return null;
}

/** The hand-off shows on a shell screen unless it's that night's own screen (§5 H0h). */
export function isOwnNightPath(pathname: string, nightId: string): boolean {
  const own = nightHref(nightId);
  return pathname === own || pathname.startsWith(`${own}/`);
}

/** The hand-off's status line (`copy.h.handoff.<status>`); `tonight` adds the movie in bold. */
export function handoffLine(status: NightStatus): string {
  if (status === "voting") return HOME_COPY.handoff.voting;
  if (status === "revealed") return HOME_COPY.handoff.revealed;
  if (status === "tonight") return HOME_COPY.handoff.tonight;
  return HOME_COPY.handoff.draft;
}

/**
 * The toast's headline (guest-home §5 H0c): "Movie night started · {title}". The title is the
 * night's own, else tonight's winner once it is in (never while voting), else just the headline.
 */
export function toastTitle(
  night: Pick<NightSummary, "status" | "title" | "winner">,
): string | null {
  if (night.title) return night.title;
  if (night.status === "revealed" || night.status === "tonight") return night.winner?.title ?? null;
  return null;
}

/**
 * Whether the new-night toast shows (§5 H0c): a live night that isn't this screen's own, that this
 * tab hasn't shown or dismissed (`isNew`, `stayed`), or whose countdown is already under way in
 * this page load (so it follows the phone from screen to screen until joined, dismissed or moved).
 */
export function toastVisible(input: {
  pathname: string;
  nightId: string | undefined;
  isNew: boolean;
  stayed: boolean;
  counting: boolean;
}): boolean {
  const { pathname, nightId, isNew, stayed, counting } = input;
  if (nightId === undefined || stayed || isOwnNightPath(pathname, nightId)) return false;
  return isNew || counting;
}

/**
 * What the countdown's polite live region says now (§5 H0c): the countdown at 60, 30 and 10 s,
 * "Paused…" while paused, and otherwise the previous message, so nothing is re-announced each second.
 */
export function countdownAnnouncement(
  previous: string,
  countdown: { seconds: number; paused: boolean },
): string {
  if (countdown.paused) return HOME_COPY.handoff.paused;
  if (countdown.seconds === 60 || countdown.seconds === 30 || countdown.seconds === 10) {
    return HOME_COPY.handoff.countdown(countdown.seconds);
  }
  return previous;
}
