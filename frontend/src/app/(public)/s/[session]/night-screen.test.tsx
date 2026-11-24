// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Night, OwnBallot, OwnRating, PersonTile } from "@/lib/api";

import { ballotDraftKey } from "./ballot-draft";

const me: PersonTile = {
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
};

const options = [
  { id: "o1", title: "Moana", year: 2016, poster_path: null, position: 0 },
  { id: "o2", title: "Up", year: 2009, poster_path: null, position: 1 },
  { id: "o3", title: "Coco", year: 2017, poster_path: null, position: 2 },
];

function makeNight(status: Night["status"], id = "n1"): Night {
  const decided = status === "closed" || status === "tonight" || status === "revealed";
  return {
    id,
    status,
    title: null,
    created_at: "2026-10-10T19:00:00Z",
    voting_method: "top3",
    ballot_size: 2,
    options,
    rating: null,
    result: decided
      ? {
          winner_option_id: "o2",
          tiebreak: "none",
          ballot_count: 3,
          placements: [
            { option_id: "o2", place: 1, score: 5 },
            { option_id: "o1", place: 2, score: 3 },
          ],
        }
      : null,
  } as unknown as Night;
}

const state: {
  night: Night;
  latestId?: string;
  liveNight?: { id: string; status: string };
  ballots: OwnBallot[];
  ratings: OwnRating[];
} = { night: makeNight("draft"), ballots: [], ratings: [] };

vi.mock("next/navigation", () => ({
  usePathname: () => "/s/n1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The shell is piece A's and tested there; here only the props each screen hands it matter.
vi.mock("@/components/home/guest-shell", () => ({
  GuestShell: ({
    screen,
    hideNav = false,
    back,
    children,
  }: {
    screen: string;
    hideNav?: boolean;
    back?: { href: string; label: string };
    children: React.ReactNode;
  }) => (
    <main
      data-screen={screen}
      data-hide-nav={hideNav}
      data-back={back ? `${back.label}:${back.href}` : undefined}
    >
      {children}
    </main>
  ),
}));
vi.mock("@/components/night/here-tonight", () => ({ HereTonight: () => null }));
vi.mock("@/components/night/rating-panel", () => ({
  myRatingsKey: (id: string) => ["night", id, "ratings"],
  RatingPanel: () => <div data-testid="rating-panel" />,
}));
vi.mock("@/components/photos/photo-album", () => ({
  PhotoAlbum: ({ canAdd = true, primary = true }: { canAdd?: boolean; primary?: boolean }) => (
    <div data-testid="photo-album" data-can-add={canAdd} data-primary={primary} />
  ),
}));
vi.mock("@/components/night/switch-sheet", () => ({
  CurrentChip: () => <p data-testid="current-chip" />,
  SwitchSheet: () => null,
}));
vi.mock("@/hooks/use-live-session", () => ({
  nightKey: (id: string) => ["night", id],
  useLiveSession: () => ({ data: state.night, live: "live", isPending: false, isError: false }),
}));
vi.mock("@/hooks/use-phone", () => ({
  PEOPLE_KEY: ["people"],
  usePhonePeople: () => ({
    people: { isSuccess: true, isPending: false, isError: false, data: [me] },
    current: me,
    noDevice: false,
  }),
  useLatestNight: () => ({ data: state.latestId ? [{ id: state.latestId }] : undefined }),
}));
vi.mock("@/hooks/use-household-night", () => ({
  useHouseholdNight: () => ({ night: state.liveNight, isNew: false, markSeen: () => {} }),
  markNightSeen: () => {},
}));
vi.mock("@/hooks/use-voters", () => ({ useVoters: () => ({ data: [] }) }));
vi.mock("@/lib/api", () => ({
  api: {
    myBallots: async () => state.ballots,
    myRatings: async () => state.ratings,
    present: async () => ({ present: [] }),
    castBallot: async () => undefined,
  },
}));

const { NightScreen } = await import("./night-screen");
const { hasRated, wrapPrimary } = await import("./past-night");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// TanStack batches notifications on a timer; microtasks let `act` flush them without sleeping.
notifyManager.setScheduler(queueMicrotask);

let root: Root;
let host: HTMLDivElement;
const main = () => host.querySelector<HTMLElement>("main");
const primaries = () => host.querySelectorAll('[data-testid="primary-action"]');

async function show(night: Night) {
  state.night = night;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NightScreen sessionId={night.id} />
      </QueryClientProvider>,
    ),
  );
  // Let the ballots/ratings queries settle (their mocks resolve at once).
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  sessionStorage.clear();
  state.latestId = undefined;
  state.liveNight = undefined;
  state.ballots = [];
  state.ratings = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("wrapPrimary (§5 H3w)", () => {
  it("is the hand-off while a night is live, else stars until rated, then Back to Home", () => {
    expect(wrapPrimary({ liveNight: true, rated: false, attended: true })).toBe("handoff");
    expect(wrapPrimary({ liveNight: true, rated: undefined, attended: undefined })).toBe("handoff");
    expect(wrapPrimary({ liveNight: false, rated: undefined, attended: undefined })).toBeNull();
    expect(wrapPrimary({ liveNight: false, rated: false, attended: true })).toBe("stars");
    expect(wrapPrimary({ liveNight: false, rated: true, attended: true })).toBe("home");
    // Issue #91: not part of the night, so no stars to give.
    expect(wrapPrimary({ liveNight: false, rated: false, attended: false })).toBe("home");
  });
});

describe("hasRated (§5 H3w)", () => {
  it("counts a score, not the null row /ratings/mine lists for everyone the phone holds", () => {
    expect(hasRated(undefined, "ava")).toBeUndefined();
    expect(hasRated([], "ava")).toBe(false);
    expect(hasRated([{ person_id: "ava", score: null }], "ava")).toBe(false);
    expect(hasRated([{ person_id: "leo", score: 4 }], "ava")).toBe(false);
    expect(hasRated([{ person_id: "ava", score: 5 }], "ava")).toBe(true);
  });
});

describe("live-night screens in the shell (§5 S9–S13)", () => {
  it.each([
    ["draft", "almost-ready"],
    ["revealed", "winner"],
    ["tonight", "tonight"],
  ] as const)("%s → %s with the nav and no chip", async (status, screen) => {
    await show(makeNight(status));
    expect(main()?.dataset.screen).toBe(screen);
    expect(main()?.dataset.hideNav).toBe("false");
    expect(host.querySelector('[data-testid="current-chip"]')).toBeNull();
  });

  it("a draft is a proper waiting screen: what's happening, no primary, a way Home (#70)", async () => {
    await show(makeNight("draft"));
    expect(main()?.dataset.screen).toBe("almost-ready");
    expect(host.querySelector("h1")?.textContent).toBe("Almost ready");
    expect(host.textContent).toContain("Movie night is being set up");
    expect(host.querySelector('[data-testid="waiting"]')?.textContent).toContain(
      "The host is picking movies",
    );
    expect(host.textContent).toContain("You can leave this screen");
    expect(primaries()).toHaveLength(0);
    expect(host.querySelector('[data-testid="draft-home"]')?.getAttribute("href")).toBe("/");
  });

  it("the ballot hides the nav, links ‹ Home and keeps the chip (AC-H0.2)", async () => {
    await show(makeNight("voting"));
    expect(main()?.dataset.screen).toBe("ballot");
    expect(main()?.dataset.hideNav).toBe("true");
    expect(main()?.dataset.back).toBe("Home:/");
    expect(host.querySelector('[data-testid="current-chip"]')).not.toBeNull();
  });

  it("picks-in keeps the nav and the chip", async () => {
    state.ballots = [{ person_id: "p1", ranks: [{ option_id: "o1", rank: 1 }] }];
    await show(makeNight("voting"));
    expect(main()?.dataset.screen).toBe("picks-in");
    expect(main()?.dataset.hideNav).toBe("false");
    expect(host.querySelector('[data-testid="current-chip"]')).not.toBeNull();
  });

  it("restores unsaved picks after leaving the ballot", async () => {
    sessionStorage.setItem(
      ballotDraftKey("n1", "p1"),
      JSON.stringify([
        { option_id: "o3", rank: 1 },
        { option_id: "o1", rank: 2 },
      ]),
    );
    await show(makeNight("voting"));
    const ranks = [...host.querySelectorAll<HTMLElement>("button[data-rank]")].map(
      (b) => `${b.textContent?.match(/Moana|Up|Coco/)?.[0]}:${b.dataset.rank}`,
    );
    expect(ranks).toEqual(["Moana:2", "Coco:1"]);
  });

  it("reopens the ballot when the draft differs from saved picks, and keeps each tap", async () => {
    state.ballots = [{ person_id: "p1", ranks: [{ option_id: "o1", rank: 1 }] }];
    sessionStorage.setItem(
      ballotDraftKey("n1", "p1"),
      JSON.stringify([{ option_id: "o2", rank: 1 }]),
    );
    await show(makeNight("voting"));
    expect(main()?.dataset.screen).toBe("ballot");
    const coco = [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((b) =>
      b.textContent?.includes("Coco"),
    );
    await act(async () => coco?.click());
    expect(JSON.parse(sessionStorage.getItem(ballotDraftKey("n1", "p1")) ?? "[]")).toEqual([
      { option_id: "o2", rank: 1 },
      { option_id: "o3", rank: 2 },
    ]);
  });
});

describe("ballot drafts", () => {
  it("an untouched ballot keeps no draft, so a vote cast on another phone shows as picks-in", async () => {
    await show(makeNight("voting"));
    expect(main()?.dataset.screen).toBe("ballot");
    expect(sessionStorage.getItem(ballotDraftKey("n1", "p1"))).toBeNull();

    // The same person votes on another phone; this phone re-renders with the saved picks.
    act(() => root.unmount());
    root = createRoot(host);
    state.ballots = [{ person_id: "p1", ranks: [{ option_id: "o1", rank: 1 }] }];
    await show(makeNight("voting"));
    expect(main()?.dataset.screen).toBe("picks-in");
  });
});

describe("past nights (§5 H3)", () => {
  it("the latest night is That's a wrap with ‹ History", async () => {
    state.latestId = "n1";
    await show(makeNight("closed"));
    expect(main()?.dataset.screen).toBe("wrap");
    expect(main()?.dataset.back).toBe("History:/history");
    expect(host.textContent).toContain("That's a wrap");
    expect(host.textContent).not.toContain("Past movie nights");
    expect(host.querySelector('[data-testid="current-chip"]')).toBeNull();
    // Add photos stays on the wrap, as a `secondary` button (the stars or Go are the primary).
    const album = host.querySelector<HTMLElement>('[data-testid="photo-album"]');
    expect(album?.dataset.canAdd).toBe("true");
    expect(album?.dataset.primary).toBe("false");
  });

  it("wrap, no live night, unrated: the star row is the one primary (AC-H3.2)", async () => {
    state.latestId = "n1";
    state.ratings = [{ person_id: "p1", score: null, attended: true }];
    await show(makeNight("closed"));
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0].querySelector('[data-testid="rating-panel"]')).not.toBeNull();
  });

  it("wrap, no live night, rated: Back to Home is the one primary (AC-H3.2)", async () => {
    state.latestId = "n1";
    state.ratings = [{ person_id: "p1", score: 4, attended: true }];
    await show(makeNight("closed"));
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0].textContent).toBe("Back to Home");
    expect(primaries()[0].getAttribute("href")).toBe("/");
  });

  it("wrap, not part of the night: Back to Home is the one primary (issue #91)", async () => {
    state.latestId = "n1";
    state.ratings = [{ person_id: "p1", score: null, attended: false }];
    await show(makeNight("closed"));
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0].textContent).toBe("Back to Home");
  });

  it("wrap with a newer night live: the small live-night link is the one primary (AC-H3.1)", async () => {
    // Until the 30 s latest-night poll sees the new night, this is still That's a wrap.
    state.liveNight = { id: "n2", status: "draft" };
    await show(makeNight("closed"));
    expect(main()?.dataset.screen).toBe("wrap");
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0].getAttribute("href")).toBe("/s/n2");
    expect(primaries()[0].textContent).toBe("Go to tonight's movie night");
  });

  it("the recap with a newer night live: the same link, as its one primary", async () => {
    state.latestId = "n9";
    state.liveNight = { id: "n2", status: "voting" };
    await show(makeNight("closed"));
    expect(main()?.dataset.screen).toBe("recap");
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0].getAttribute("href")).toBe("/s/n2");
  });

  it("stays That's a wrap when the latest-night poll then sees a newer night", async () => {
    state.latestId = "n1";
    await show(makeNight("closed"));
    expect(main()?.dataset.screen).toBe("wrap");
    const shell = main();
    state.latestId = "n2";
    state.liveNight = { id: "n2", status: "draft" };
    await show(makeNight("closed"));
    expect(main()?.dataset.screen).toBe("wrap");
    // Same element: the shell was never remounted.
    expect(main()).toBe(shell);
  });

  it("an older night is the recap: no primary, my picks with the winner marked (AC-H3.3)", async () => {
    state.latestId = "n9";
    state.ballots = [
      {
        person_id: "p1",
        ranks: [
          { option_id: "o2", rank: 2 },
          { option_id: "o1", rank: 1 },
        ],
      },
    ];
    await show(makeNight("closed"));
    expect(main()?.dataset.screen).toBe("recap");
    expect(main()?.dataset.back).toBe("History:/history");
    expect(primaries()).toHaveLength(0);
    const picks = [...host.querySelectorAll<HTMLElement>('[data-testid="recap-picks"] li')];
    expect(picks.map((li) => li.textContent)).toEqual(["1.Moana", "2.UpYour pick won"]);
    expect(picks[1].dataset.winner).toBe("true");
    expect(host.querySelector('[data-testid="photo-album"]')?.getAttribute("data-can-add")).toBe(
      "false",
    );
    expect(
      host.querySelector<HTMLAnchorElement>('[data-testid="recap-photos"]')?.getAttribute("href"),
    ).toBe("/albums/n1");
  });
});
