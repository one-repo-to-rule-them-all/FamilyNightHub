// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NightSummary, PersonTile } from "@/lib/api";

const state: { pathname: string; night?: Partial<NightSummary> } = { pathname: "/history" };
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

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-phone", () => ({
  usePhonePeople: () => ({ people: { isSuccess: true, data: [me] }, current: me }),
}));
vi.mock("@/hooks/use-household-night", () => ({
  useHouseholdNight: () => ({ night: state.night, isNew: false, markSeen: () => {} }),
  markNightSeen: () => {},
}));
// The switch sheet pulls in TanStack Query; the shell only needs to know it opens.
vi.mock("@/components/night/switch-sheet", () => ({
  SwitchSheet: () => <dialog open data-testid="switch-sheet" />,
}));

const { GuestShell } = await import("./guest-shell");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function render(ui: React.ReactNode) {
  act(() => root.render(ui));
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  state.pathname = "/history";
  state.night = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("GuestShell (§5 H0)", () => {
  it("frames the page: app bar, data-screen, a three-tab nav with the active tab (AC-H0.1)", () => {
    render(
      <GuestShell screen="history">
        <p>content</p>
      </GuestShell>,
    );
    expect(host.querySelector('main[data-screen="history"]')?.textContent).toContain("content");
    expect(q("household-name")?.textContent).toBe("Family Night");
    const links = [...host.querySelectorAll('[data-testid="bottom-nav"] a')];
    expect(links.map((a) => a.textContent)).toEqual(["Home", "History", "Me"]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, "page", null]);
    expect(q("live-dot")).toBeNull();
    expect(q("live-handoff")).toBeNull();
  });

  it("reads the household name from the last join and opens the switch sheet", () => {
    localStorage.setItem(
      "fnh.lastJoin",
      JSON.stringify({ slug: "baez", householdName: "The Baez Family" }),
    );
    render(<GuestShell screen="me">x</GuestShell>);
    expect(q("household-name")?.textContent).toBe("The Baez Family");
    const person = q("app-bar-person");
    expect(person?.getAttribute("aria-label")).toBe("Switch person (now RooDog)");
    act(() => person?.click());
    expect(q("switch-sheet")).not.toBeNull();
  });

  it("shows the back link when given one", () => {
    render(
      <GuestShell screen="recap" back={{ href: "/history", label: "History" }}>
        x
      </GuestShell>,
    );
    expect(q("app-bar-back")?.getAttribute("href")).toBe("/history");
  });

  it("puts the plain hand-off on a browse screen while a night is live, plus the live dot", () => {
    state.night = { id: "n2", status: "voting", winner: null };
    render(<GuestShell screen="history">x</GuestShell>);
    expect(q("live-handoff")).not.toBeNull();
    expect(q("handoff-countdown")).toBeNull();
    expect(q("live-dot")?.getAttribute("aria-label")).toBe("Movie night is on");
  });

  it("carries the countdown when asked (That's a wrap, the recap)", () => {
    state.pathname = "/s/old";
    state.night = { id: "n2", status: "draft", winner: null };
    render(
      <GuestShell screen="wrap" handoff="countdown">
        x
      </GuestShell>,
    );
    expect(q("handoff-countdown")?.dataset.seconds).toBe("60");
  });

  it("never shows the hand-off on Home or on the live night's own screen (AC-H3.4)", () => {
    state.night = { id: "n2", status: "voting", winner: null };
    state.pathname = "/";
    render(
      <GuestShell screen="home" handoff="none">
        x
      </GuestShell>,
    );
    expect(q("live-handoff")).toBeNull();
    state.pathname = "/s/n2";
    render(<GuestShell screen="almost-ready">x</GuestShell>);
    expect(q("live-handoff")).toBeNull();
  });

  it("hides the nav on the ballot (AC-H0.2)", () => {
    state.pathname = "/s/n2";
    render(
      <GuestShell screen="ballot" hideNav handoff="none">
        x
      </GuestShell>,
    );
    expect(q("bottom-nav")).toBeNull();
  });
});
