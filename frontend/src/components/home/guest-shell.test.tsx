// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetCountdownForTests } from "@/hooks/use-auto-move-countdown";
import type { NightSummary, PersonTile } from "@/lib/api";

const state: { pathname: string; night?: Partial<NightSummary>; isNew: boolean } = {
  pathname: "/history",
  isNew: false,
};
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
  useHouseholdNight: () => ({ night: state.night, isNew: state.isNew, markSeen: () => {} }),
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
  state.isNew = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  resetCountdownForTests();
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
    expect(q("night-toast")).toBeNull();
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

  it("mounts the new-night toast on any screen for a new night, above the nav (§5 H0c)", () => {
    state.night = { id: "n2", status: "voting", winner: null, title: null };
    state.isNew = true;
    render(<GuestShell screen="history">x</GuestShell>);
    const toast = q("night-toast");
    expect(toast?.dataset.night).toBe("n2");
    expect(toast?.className).toContain("bottom-[calc(3.5rem");
    expect(q("handoff-countdown")?.dataset.seconds).toBe("60");
    expect(q("live-dot")?.getAttribute("aria-label")).toBe("Movie night is on");
    // The nav is still there and still a sibling of the toast, not under it.
    expect(q("bottom-nav")).not.toBeNull();
    expect(q("live-handoff")).toBeNull();
  });

  it("shows no toast for a night this tab has already shown", () => {
    state.night = { id: "n2", status: "voting", winner: null, title: null };
    render(<GuestShell screen="me">x</GuestShell>);
    expect(q("night-toast")).toBeNull();
    expect(q("live-dot")).not.toBeNull();
  });

  it("never shows the toast on the live night's own screens", () => {
    state.night = { id: "n2", status: "voting", winner: null, title: null };
    state.isNew = true;
    state.pathname = "/s/n2";
    render(<GuestShell screen="almost-ready">x</GuestShell>);
    expect(q("night-toast")).toBeNull();
  });

  it("hides the nav on the ballot (AC-H0.2)", () => {
    state.pathname = "/s/n2";
    render(
      <GuestShell screen="ballot" hideNav>
        x
      </GuestShell>,
    );
    expect(q("bottom-nav")).toBeNull();
  });
});
