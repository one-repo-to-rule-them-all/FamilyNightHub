// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NightSummary, PersonTile, Profile, ProfileNight } from "@/lib/api";

const me = { id: "p1", name: "RooDog", current: true, binding: "mine" } as PersonTile;

const movie = (title: string) =>
  ({ title, poster_path: null }) as ProfileNight["picks"][number]["movie"];
const night = (id: string, extra: Partial<ProfileNight>): ProfileNight => ({
  session_id: id,
  date: "2026-10-17T20:00:00Z",
  status: "closed",
  title: null,
  voting_method: "top3",
  winner: movie(`Winner ${id}`),
  picks: [],
  picked_winner: false,
  rating: null,
  photo_count: 0,
  ...extra,
});

const state: { search: string; profile: Profile; nights: NightSummary[] } = {
  search: "",
  profile: {} as Profile,
  nights: [],
};

const api = {
  profile: vi.fn(async () => state.profile),
  nights: vi.fn(async () => state.nights),
};

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api,
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    replace,
    scroll,
    ...rest
  }: React.ComponentProps<"a"> & { replace?: boolean; scroll?: boolean }) => (
    <a href={href} data-replace={replace} data-scroll={scroll} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/hooks/use-phone", () => ({
  usePhonePeople: () => ({ people: { isSuccess: true, data: [me] }, current: me, noDevice: false }),
}));
vi.mock("@/components/home/guest-shell", () => ({
  GuestShell: ({ screen, children }: { screen: string; children: React.ReactNode }) => (
    <main data-screen={screen}>{children}</main>
  ),
}));

const { HistoryScreen } = await import("./history-screen");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Query results land on microtasks, so a test can flush them without waiting on timers.
notifyManager.setScheduler(queueMicrotask);

let root: Root;
let host: HTMLDivElement;
const q = (testId: string, from: ParentNode = host) =>
  from.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <HistoryScreen />
      </QueryClientProvider>,
    ),
  );
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await Promise.resolve();
    });
}

beforeEach(() => {
  state.search = "";
  state.nights = [];
  state.profile = {
    stats: { nights_joined: 2, winners_picked: 1, average_rating_given: 4 },
    nights: [
      night("n1", {
        picks: [
          { option_id: "a", rank: 2, movie: movie("Coco") },
          { option_id: "b", rank: 1, movie: movie("Winner n1") },
        ],
        picked_winner: true,
        rating: 4,
        photo_count: 3,
      }),
      night("n2", { picks: [{ option_id: "c", rank: 1, movie: movie("Up") }] }),
    ],
  } as unknown as Profile;
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("History (H2)", () => {
  it("opens on Mine with picks, won, rated or Rate it, and photos (AC-H4.1)", async () => {
    await render();
    expect(host.querySelector('main[data-screen="history"]')).not.toBeNull();
    expect(q("history")?.dataset.tab).toBe("mine");
    expect(q("history-tab-mine")?.getAttribute("aria-selected")).toBe("true");
    expect(q("history-summary")?.textContent).toBe("2 nights · 1 winning pick · ★ 4.0 average");

    const [first, second] = host.querySelectorAll<HTMLElement>('[data-testid="history-row"]');
    expect(q("history-picks", first)?.textContent).toBe("Your picks: Winner n1, Coco");
    expect(q("history-won", first)?.textContent).toBe("Your pick won");
    expect(q("history-rated", first)?.textContent).toBe("You rated ★4");
    expect(q("history-rate", first)).toBeNull();
    expect(q("history-photos", first)?.getAttribute("href")).toBe("/albums/n1");
    expect(first.querySelector("a")?.getAttribute("href")).toBe("/s/n1");

    expect(q("history-won", second)).toBeNull();
    expect(q("history-rated", second)).toBeNull();
    expect(q("history-rate", second)?.getAttribute("href")).toBe("/s/n2#rate");
    expect(q("history-photos", second)).toBeNull();
    expect(api.nights).not.toHaveBeenCalled();
  });

  it("Family (?tab=family) lists the nights with turnout (AC-H4.2)", async () => {
    state.search = "tab=family";
    state.nights = [
      {
        id: "n1",
        created_at: "2026-10-17T20:00:00Z",
        revealed_at: null,
        turnout: 6,
        winner: { title: "Paddington 2", poster_path: null },
        rating: null,
      } as unknown as NightSummary,
    ];
    await render();
    expect(q("history")?.dataset.tab).toBe("family");
    expect(q("history-tab-family")?.getAttribute("aria-selected")).toBe("true");
    expect(q("history-tab-family")?.getAttribute("href")).toBe("/history?tab=family");
    expect(q("history-turnout")?.textContent).toBe("6 voted");
    expect(q("history-winner")?.textContent).toBe("Paddington 2");
  });

  it("shows the copy-deck empty states (AC-H4.3)", async () => {
    state.profile = { ...state.profile, nights: [] };
    await render();
    expect(q("history-empty")?.textContent).toBe(
      "Your movie nights will show up here after the first one.",
    );

    act(() => root.unmount());
    root = createRoot(host);
    state.search = "tab=family";
    await render();
    expect(q("history-empty")?.textContent).toBe(
      "No movie nights yet. Tonight could be the first.",
    );
  });
});
