// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetCountdownForTests } from "@/hooks/use-auto-move-countdown";
import type { NightSummary } from "@/lib/api";
import { holdAutoMove } from "@/lib/auto-move";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { NightToast, resetSetupForTests } = await import("./night-toast");
const { LiveNightLink } = await import("./live-night-link");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Night = Pick<NightSummary, "id" | "status" | "title" | "winner">;
const voting = (id = "n2"): Night => ({ id, status: "voting", title: null, winner: null });
const draft = (id = "n2"): Night => ({ id, status: "draft", title: null, winner: null });

let root: Root;
let host: HTMLDivElement;

function render(
  night: Night | undefined,
  { isNew = true, pathname = "/history" }: { isNew?: boolean; pathname?: string } = {},
) {
  act(() => root.render(<NightToast night={night} isNew={isNew} pathname={pathname} aboveNav />));
}

/** A route change: the old screen's shell unmounts and the next one mounts its own toast. */
function navigate(night: Night | undefined, options?: { isNew?: boolean; pathname?: string }) {
  act(() => root.unmount());
  root = createRoot(host);
  render(night, options);
}

const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const seconds = () => Number(q("handoff-countdown")?.dataset.seconds);
const advance = (s: number) => act(() => vi.advanceTimersByTime(s * 1_000));

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  push.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  resetCountdownForTests();
  resetSetupForTests();
  host.remove();
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  vi.useRealTimers();
});

describe("NightToast (§5 H0c, issue #70)", () => {
  it("says the night started, with Join, a 60 s countdown and Stay here", () => {
    render({ ...voting(), title: "Spooky Saturday" });
    expect(q("night-toast")?.dataset.night).toBe("n2");
    expect(q("toast-line")?.textContent).toContain("Movie night started · Spooky Saturday");
    expect(q("toast-join")?.textContent).toBe("Join");
    expect(q("handoff-stay")?.textContent).toBe("Stay here");
    expect(seconds()).toBe(60);
    expect(q("handoff-countdown")?.textContent).toBe("Taking you there in 60s");
    expect(q("handoff-announce")?.textContent).toBe(
      "Movie night started · Spooky Saturday. Taking you there in 60s",
    );
    // It is a notification, not the screen's primary.
    expect(host.querySelector('[data-testid="primary-action"]')).toBeNull();
  });

  it("Join goes to the night at once and marks it seen (the #70 Join bug)", () => {
    render(voting());
    advance(5);
    act(() => q("toast-join")?.click());
    expect(push).toHaveBeenCalledExactlyOnceWith("/s/n2");
    expect(sessionStorage.getItem("fnh.seenNight")).toBe("n2");
    // The countdown is over: nothing moves the phone a second time.
    advance(120);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("ticks once a second and moves at 0 with router.push, marking the night seen", () => {
    render(voting());
    advance(10);
    expect(seconds()).toBe(50);
    advance(20);
    expect(q("handoff-announce")?.textContent).toContain("Taking you there in 30s");
    expect(push).not.toHaveBeenCalled();
    advance(30);
    expect(push).toHaveBeenCalledExactlyOnceWith("/s/n2");
    expect(sessionStorage.getItem("fnh.seenNight")).toBe("n2");
    advance(5);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("follows the phone across screens, keeping its second", () => {
    render(voting(), { pathname: "/s/old" });
    advance(15);
    // History, where the night is no longer "new" (say the 10-minute window closed): still up.
    navigate(voting(), { pathname: "/history", isNew: false });
    expect(q("night-toast")).not.toBeNull();
    expect(seconds()).toBe(45);
    advance(5);
    navigate(voting(), { pathname: "/me", isNew: false });
    expect(seconds()).toBe(40);
    advance(40);
    expect(push).toHaveBeenCalledExactlyOnceWith("/s/n2");
  });

  it("pauses while an upload holds it and resumes from the same second", () => {
    render(voting());
    advance(10);
    const release = holdAutoMove();
    advance(1);
    expect(q("handoff-countdown")?.textContent).toBe("Paused while you finish up");
    expect(q("handoff-announce")?.textContent).toContain("Paused while you finish up");
    advance(120);
    expect(seconds()).toBe(50);
    expect(push).not.toHaveBeenCalled();
    act(() => release());
    advance(50);
    expect(push).toHaveBeenCalledWith("/s/n2");
  });

  it("pauses while a <dialog> is open", () => {
    render(voting());
    advance(30);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    advance(90);
    expect(seconds()).toBe(30);
    expect(q("handoff-countdown")?.dataset.paused).toBe("true");
    dialog.removeAttribute("open");
    advance(29);
    expect(push).not.toHaveBeenCalled();
    advance(2);
    expect(push).toHaveBeenCalledWith("/s/n2");
  });

  it("pauses while the page is hidden", () => {
    render(voting());
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    advance(30);
    expect(seconds()).toBe(60);
    visibility.mockRestore();
    advance(10);
    expect(seconds()).toBe(50);
  });

  it("Stay here dismisses it for that night in this tab; a second new night brings it back", () => {
    render(voting());
    advance(20);
    act(() => q("handoff-stay")?.click());
    expect(q("night-toast")).toBeNull();
    expect(sessionStorage.getItem("fnh.stayNight")).toBe("n2");
    advance(120);
    expect(push).not.toHaveBeenCalled();

    // Another screen in the same tab: still dismissed for that night.
    navigate(voting(), { pathname: "/me" });
    expect(q("night-toast")).toBeNull();

    // A second new night brings a fresh toast at 60.
    render(voting("n3"));
    expect(q("night-toast")?.dataset.night).toBe("n3");
    expect(seconds()).toBe(60);
  });

  it("starts again at 60 when the night changes", () => {
    render(voting());
    advance(25);
    expect(seconds()).toBe(35);
    render(voting("n3"));
    expect(seconds()).toBe(60);
    advance(60);
    expect(push).toHaveBeenCalledExactlyOnceWith("/s/n3");
  });

  it("never shows, or moves, on the night's own screens, and counts them as seen", () => {
    render(voting(), { pathname: "/s/n2" });
    expect(q("night-toast")).toBeNull();
    expect(sessionStorage.getItem("fnh.seenNight")).toBe("n2");
    advance(120);
    expect(push).not.toHaveBeenCalled();
  });

  it("stops a running countdown once the phone reaches the night some other way", () => {
    render(voting());
    advance(20);
    navigate(voting(), { pathname: "/s/n2", isNew: false });
    navigate(voting(), { pathname: "/history", isNew: false });
    expect(q("night-toast")).toBeNull();
    advance(120);
    expect(push).not.toHaveBeenCalled();
  });

  it("shows nothing without a night, or for a night this tab has already shown", () => {
    render(undefined);
    expect(q("night-toast")).toBeNull();
    render(voting(), { isNew: false });
    expect(q("night-toast")).toBeNull();
    expect(q("handoff-announce")?.textContent).toBe("");
  });

  it("names tonight's winner once it is in", () => {
    render({
      id: "n2",
      status: "tonight",
      title: null,
      winner: { title: "Paddington", poster_path: null } as Night["winner"],
    });
    expect(q("toast-line")?.textContent).toContain("Movie night started · Paddington");
  });
});

describe("NightToast for a night still in draft (the #70 Join bug)", () => {
  it("only says it is being set up: no Join, no countdown, and it never moves the phone", () => {
    render(draft());
    expect(q("night-toast")?.dataset.phase).toBe("setup");
    expect(q("toast-line")?.textContent).toContain("Movie night is being set up");
    expect(q("toast-join")).toBeNull();
    expect(q("handoff-countdown")).toBeNull();
    expect(q("handoff-stay")).toBeNull();
    expect(q("handoff-announce")?.textContent).toBe(
      "Movie night is being set up. We'll tell you when voting opens.",
    );
    advance(180);
    expect(push).not.toHaveBeenCalled();
  });

  it("becomes the full toast when voting opens, with a fresh 60 s countdown", () => {
    render(draft(), { pathname: "/s/old" });
    advance(90);
    // Setup ran past the 10-minute "new" window: the phone saw the draft, so voting still counts.
    navigate(voting(), { pathname: "/history", isNew: false });
    expect(q("night-toast")?.dataset.phase).toBe("started");
    expect(q("toast-join")).not.toBeNull();
    expect(seconds()).toBe(60);
    advance(60);
    expect(push).toHaveBeenCalledExactlyOnceWith("/s/n2");
  });

  it("OK hides the setup toast on every screen, but voting opening still brings Join", () => {
    render(draft());
    act(() => q("toast-hide")?.click());
    expect(q("night-toast")).toBeNull();
    expect(sessionStorage.getItem("fnh.stayNight")).toBeNull();
    navigate(draft(), { pathname: "/me" });
    expect(q("night-toast")).toBeNull();
    render(voting(), { pathname: "/me" });
    expect(q("toast-join")).not.toBeNull();
  });

  it("shows no setup toast for an old draft this page load never saw", () => {
    render(draft(), { isNew: false });
    expect(q("night-toast")).toBeNull();
    render(voting(), { isNew: false });
    expect(q("night-toast")).toBeNull();
  });
});

describe("LiveNightLink (§5 H3w, H3r)", () => {
  it("links to tonight's night, marks it seen, and is the primary only when asked", () => {
    act(() => root.render(<LiveNightLink night={{ id: "n2", status: "voting" }} primary />));
    const link = q("primary-action");
    expect(link?.getAttribute("href")).toBe("/s/n2");
    expect(link?.textContent).toBe("Go to tonight's movie night");
    act(() => link?.click());
    expect(sessionStorage.getItem("fnh.seenNight")).toBe("n2");
    act(() =>
      root.render(<LiveNightLink night={{ id: "n2", status: "voting" }} primary={false} />),
    );
    expect(q("primary-action")).toBeNull();
    expect(q("live-night-link")).not.toBeNull();
  });
});
