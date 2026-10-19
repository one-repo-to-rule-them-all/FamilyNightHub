// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as TonightCard from "@/components/home/tonight-card";
import type { NightSummary, OwnBallot, PersonTile } from "@/lib/api";

type TonightModule = typeof TonightCard;

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

const state: {
  search: string;
  people: PersonTile[] | undefined;
  noDevice: boolean;
  night: Pick<NightSummary, "id" | "status"> | undefined;
  liveLoaded: boolean;
  ballots: OwnBallot[] | undefined;
  ratePrompt: object | null;
} = {
  search: "",
  people: [me],
  noDevice: false,
  night: undefined,
  liveLoaded: true,
  ballots: [],
  ratePrompt: null,
};
const replace = vi.fn();
const seen = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ enabled }: { enabled?: boolean }) => ({
    data: enabled ? state.ballots : undefined,
    isPending: enabled ? state.ballots === undefined : true,
  }),
}));
vi.mock("@/hooks/use-phone", () => ({
  usePhonePeople: () => ({
    people: { data: state.people, isSuccess: state.people !== undefined, isError: false },
    current: state.people?.find((p) => p.current) ?? null,
    noDevice: state.noDevice,
    expired: false,
  }),
  useLiveNight: () => ({
    isSuccess: state.liveLoaded,
    isError: false,
    data: state.liveLoaded ? (state.night ? [state.night] : []) : undefined,
  }),
}));
vi.mock("@/hooks/use-household-night", () => ({
  useHouseholdNight: () => ({ night: state.night, isNew: false, markSeen: () => {} }),
  markNightSeen: (id: string) => seen(id),
}));
vi.mock("@/components/night/rate-prompt-card", () => ({
  useRatePrompt: () => state.ratePrompt,
  RatePromptCard: ({ variant }: { variant?: string }) => (
    <div data-testid="rate-prompt" data-variant={variant} />
  ),
}));
vi.mock("@/components/home/guest-shell", () => ({
  GuestShell: ({ screen, children }: { screen: string; children: React.ReactNode }) => (
    <main data-screen={screen}>{children}</main>
  ),
}));
vi.mock("@/components/home/tonight-card", async () => {
  const actual = await vi.importActual<TonightModule>("@/components/home/tonight-card");
  return {
    castBallots: actual.castBallots,
    homeBallotsKey: actual.homeBallotsKey,
    Tonight: () => <section data-testid="tonight-card" />,
  };
});
vi.mock("@/components/home/recent-nights", () => ({ RecentNights: () => null }));
vi.mock("@/components/home/photo-strip", () => ({ PhotoStrip: () => null }));

const { HomeResolver, resetColdOpenForTests } = await import("./home-resolver");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

function mount() {
  act(() => root.render(<HomeResolver />));
}

const voted: OwnBallot[] = [
  { person_id: "p1", ranks: [{ option_id: "o1", rank: 1 }] },
] as unknown as OwnBallot[];

beforeEach(() => {
  resetColdOpenForTests();
  replace.mockReset();
  seen.mockReset();
  Object.assign(state, {
    search: "",
    people: [me],
    noDevice: false,
    night: undefined,
    liveLoaded: true,
    ballots: [],
    ratePrompt: null,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const remount = () => {
  act(() => root.unmount());
  root = createRoot(host);
  mount();
};

describe("Home (§5 H1)", () => {
  it("renders Home in the shell with no hand-off, and stays without a live night (AC-H1.1)", () => {
    mount();
    const main = host.querySelector<HTMLElement>("[data-screen=home]");
    expect(main).not.toBeNull();
    expect(host.textContent).toContain("Hi, RooDog");
    expect(host.querySelector('[data-testid="tonight-card"]')).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows the rating prompt as secondary unless the card is asking (T6/T7)", () => {
    state.night = { id: "n1", status: "draft" };
    mount();
    expect(host.querySelector<HTMLElement>('[data-testid="rate-prompt"]')?.dataset.variant).toBe(
      "secondary",
    );
    state.night = { id: "n1", status: "tonight" };
    mount();
    expect(host.querySelector('[data-testid="rate-prompt"]')).toBeNull();
    state.night = undefined;
    state.ratePrompt = {};
    mount();
    expect(host.querySelector('[data-testid="rate-prompt"]')).toBeNull();
  });

  it("sends a phone with nobody current to /who, unchanged from the resolver", () => {
    state.people = [{ ...me, current: false }];
    mount();
    expect(replace).toHaveBeenCalledWith("/who");
    expect(host.querySelector("[data-screen=home]")).toBeNull();
  });

  it("keeps the S0 landing for a phone with no device", () => {
    state.people = undefined;
    state.noDevice = true;
    mount();
    expect(host.querySelector("[data-screen=landing]")).not.toBeNull();
  });
});

describe("arrivals (§3.3 rule 1)", () => {
  it("jump into the live night (AC-H2.1, AC-H2.2)", () => {
    state.search = "arrive=1";
    state.night = { id: "n1", status: "draft" };
    mount();
    expect(replace).toHaveBeenCalledWith("/s/n1");
    expect(seen).toHaveBeenCalledWith("n1");
  });

  it("strip the parameter and stay on Home with no live night", () => {
    state.search = "arrive=1";
    mount();
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("wait for the live-night answer", () => {
    state.search = "arrive=1";
    state.liveLoaded = false;
    mount();
    expect(replace).not.toHaveBeenCalled();
  });

  it("work while Home is already mounted (a switch from the Tonight card)", () => {
    state.night = { id: "n1", status: "voting" };
    state.ballots = voted;
    mount();
    expect(replace).not.toHaveBeenCalled();
    state.search = "arrive=1";
    mount();
    expect(replace).toHaveBeenCalledWith("/s/n1");
  });
});

describe("cold open (§3.3 rule 2)", () => {
  it("goes straight to the ballot while voting and not voted (AC-H2.4)", () => {
    state.night = { id: "n1", status: "voting" };
    mount();
    expect(replace).toHaveBeenCalledWith("/s/n1");
  });

  it("waits for this phone's ballots before deciding", () => {
    state.night = { id: "n1", status: "voting" };
    state.ballots = undefined;
    mount();
    expect(replace).not.toHaveBeenCalled();
    state.ballots = [];
    mount();
    expect(replace).toHaveBeenCalledWith("/s/n1");
  });

  it("stays on Home when the current person already voted (AC-H2.5)", () => {
    state.night = { id: "n1", status: "voting" };
    state.ballots = voted;
    mount();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(["draft", "revealed", "tonight"] as const)("stays on Home in %s (AC-H2.6)", (status) => {
    state.night = { id: "n1", status };
    mount();
    expect(replace).not.toHaveBeenCalled();
  });

  it("is never a later mount: tapping Home stays put (AC-H2.3)", () => {
    mount();
    state.night = { id: "n1", status: "voting" };
    remount();
    expect(replace).not.toHaveBeenCalled();
  });

  it("never redirects after the first decision, even when voting opens (rule 4)", () => {
    state.night = { id: "n1", status: "draft" };
    mount();
    state.night = { id: "n1", status: "voting" };
    mount();
    expect(replace).not.toHaveBeenCalled();
  });
});
