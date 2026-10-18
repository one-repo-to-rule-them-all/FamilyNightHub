// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { LiveHandoff } = await import("./live-handoff");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Night = Pick<NightSummary, "id" | "status" | "winner">;
const draft = (id = "n2"): Night => ({ id, status: "draft", winner: null });

let root: Root;
let host: HTMLDivElement;

function render(night: Night, countdown = true) {
  act(() => root.render(<LiveHandoff night={night} countdown={countdown} />));
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
  host.remove();
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  vi.useRealTimers();
});

describe("LiveHandoff with the auto-move countdown (§5 H0c)", () => {
  it("shows Go as the one primary, a 60 s countdown and Stay here (AC-H3.5)", () => {
    render(draft());
    expect(q("live-handoff")).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="primary-action"]')).toHaveLength(1);
    expect(q("primary-action")?.textContent).toBe("Go to tonight's movie night");
    expect(q("primary-action")?.getAttribute("href")).toBe("/s/n2");
    expect(seconds()).toBe(60);
    expect(q("handoff-countdown")?.textContent).toBe("Taking you there in 60s");
    expect(q("handoff-stay")?.textContent).toBe("Stay here");
    expect(q("handoff-announce")?.textContent).toBe("Taking you there in 60s");
  });

  it("ticks once a second and moves at 0 with router.push, marking the night seen (AC-H3.6)", () => {
    render(draft());
    advance(10);
    expect(seconds()).toBe(50);
    advance(20);
    expect(q("handoff-announce")?.textContent).toBe("Taking you there in 30s");
    expect(push).not.toHaveBeenCalled();
    advance(30);
    expect(push).toHaveBeenCalledExactlyOnceWith("/s/n2");
    expect(sessionStorage.getItem("fnh.seenNight")).toBe("n2");
    advance(5);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("pauses while an upload holds it and resumes from the same second (AC-H3.9)", () => {
    render(draft());
    advance(10);
    const release = holdAutoMove();
    advance(1);
    expect(q("handoff-countdown")?.textContent).toBe("Paused while you finish up");
    expect(q("handoff-announce")?.textContent).toBe("Paused while you finish up");
    advance(120);
    expect(seconds()).toBe(50);
    expect(push).not.toHaveBeenCalled();
    act(() => release());
    advance(50);
    expect(push).toHaveBeenCalledWith("/s/n2");
  });

  it("pauses while a <dialog> is open (AC-H3.10)", () => {
    render(draft());
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
    render(draft());
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    advance(30);
    expect(seconds()).toBe(60);
    visibility.mockRestore();
    advance(10);
    expect(seconds()).toBe(50);
  });

  it("Stay here stops it for that night in this tab, and Go stays (AC-H3.8)", () => {
    render(draft());
    advance(20);
    act(() => q("handoff-stay")?.click());
    expect(q("handoff-countdown")).toBeNull();
    expect(q("handoff-stay")).toBeNull();
    expect(q("primary-action")).not.toBeNull();
    expect(sessionStorage.getItem("fnh.stayNight")).toBe("n2");
    advance(120);
    expect(push).not.toHaveBeenCalled();

    // Another past night in the same tab: no countdown for that night.
    act(() => root.unmount());
    root = createRoot(host);
    render(draft());
    expect(q("handoff-countdown")).toBeNull();

    // A second new night brings a fresh countdown.
    render(draft("n3"));
    expect(seconds()).toBe(60);
  });

  it("starts again at 60 when the hand-off's night changes", () => {
    render(draft());
    advance(25);
    expect(seconds()).toBe(35);
    render(draft("n3"));
    expect(seconds()).toBe(60);
    advance(60);
    expect(push).toHaveBeenCalledExactlyOnceWith("/s/n3");
  });

  it("is a plain hand-off without the countdown, and never moves (AC-H3.11)", () => {
    render({ id: "n2", status: "tonight", winner: null }, false);
    expect(q("handoff-countdown")).toBeNull();
    expect(q("handoff-stay")).toBeNull();
    expect(q("primary-action")).not.toBeNull();
    advance(120);
    expect(push).not.toHaveBeenCalled();
  });

  it("names tonight's movie and marks the night seen when Go is tapped", () => {
    render(
      {
        id: "n2",
        status: "tonight",
        winner: { title: "Paddington", poster_path: null } as Night["winner"],
      },
      false,
    );
    expect(q("handoff-line")?.textContent).toBe("Tonight's movie: Paddington");
    act(() => q("primary-action")?.click());
    expect(sessionStorage.getItem("fnh.seenNight")).toBe("n2");
  });
});
