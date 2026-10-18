// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OwnBallot } from "@/lib/api";
import type { TonightPrimary, TonightState } from "@/lib/home";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { castBallots, listNames, TonightCardView } = await import("./tonight-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const all = (testId: string) => host.querySelectorAll(`[data-testid="${testId}"]`);

function render(ui: React.ReactNode) {
  act(() => root.render(ui));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const go = (label: string): TonightPrimary => ({ label, href: "/s/n1" });
const movie = { title: "Wall-E", posterPath: null };

const cases: { state: TonightState; primary: TonightPrimary | null; text: string }[] = [
  { state: "T0", primary: null, text: "No movie night yet" },
  { state: "T1", primary: go("Open movie night"), text: "The host is picking movies (4 so far)." },
  { state: "T2", primary: go("Vote now"), text: "3 of 6 voted. Pick your favourites." },
  {
    state: "T3",
    primary: { label: "Pass to next person", action: "switch" },
    text: "Lulu and Bo on this phone still need to vote.",
  },
  { state: "T4", primary: null, text: "3 of 6 voted. The winner shows up here." },
  { state: "T5", primary: go("See the winner"), text: "Tonight's movie is…" },
  { state: "T6", primary: go("Add photos"), text: "Tonight: Wall-E" },
  { state: "T7", primary: { label: "Rate it", href: "/s/n0#rate" }, text: "How was Wall-E?" },
];

describe("TonightCardView (§5 H1)", () => {
  it.each(cases)("$state has exactly one primary, or none plus waiting (AC-H1.6)", (c) => {
    render(
      <TonightCardView
        state={c.state}
        primary={c.primary}
        shortlisted={4}
        votes={{ voted: 3, total: 6 }}
        waitingNames={["Lulu", "Bo"]}
        movie={movie}
        changeHref="/s/n1"
        rateHref="/s/n1#rate"
        onNotNow={() => {}}
      />,
    );
    expect(q("tonight-card")?.dataset.state).toBe(c.state);
    expect(q("tonight-card")?.textContent).toContain(c.text);
    const waiting = c.state === "T0" || c.state === "T4";
    expect(all("primary-action")).toHaveLength(waiting ? 0 : 1);
    expect(all("waiting")).toHaveLength(waiting ? 1 : 0);
    if (c.primary) expect(q("primary-action")?.textContent).toBe(c.primary.label);
    if (waiting) expect(q("waiting")?.querySelector("[aria-live=polite]")).not.toBeNull();
  });

  it("links an href primary and records the night as opened", () => {
    const onOpen = vi.fn();
    render(<TonightCardView state="T2" primary={go("Vote now")} onOpen={onOpen} />);
    const link = q("primary-action") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/s/n1");
    act(() => link.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("opens the switch sheet from T3's Pass to next person (AC-H1.3)", () => {
    const onSwitch = vi.fn();
    render(
      <TonightCardView
        state="T3"
        primary={{ label: "Pass to next person", action: "switch" }}
        waitingNames={["Lulu"]}
        onSwitch={onSwitch}
      />,
    );
    act(() => q("primary-action")?.click());
    expect(onSwitch).toHaveBeenCalledOnce();
  });

  it("offers T4's Change my picks and T6's Already watched? Rate it as secondary links (AC-H1.4)", () => {
    render(<TonightCardView state="T4" primary={null} changeHref="/s/n1" />);
    expect(q("change-picks")?.getAttribute("href")).toBe("/s/n1");
    render(<TonightCardView state="T6" primary={go("Add photos")} rateHref="/s/n1#rate" />);
    expect(q("tonight-rate")?.textContent).toBe("Already watched? Rate it");
    expect(q("tonight-rate")?.getAttribute("href")).toBe("/s/n1#rate");
    expect(q("tonight-rate")?.dataset.testid).not.toBe("primary-action");
  });

  it("T7's Not now dismisses the prompt", () => {
    const onNotNow = vi.fn();
    render(
      <TonightCardView
        state="T7"
        primary={{ label: "Rate it", href: "/s/n0#rate" }}
        movie={movie}
        onNotNow={onNotNow}
      />,
    );
    const notNow = [...host.querySelectorAll("button")].find((b) => b.textContent === "Not now");
    act(() => notNow?.click());
    expect(onNotNow).toHaveBeenCalledOnce();
  });

  it("shows Just started and announces it only for a new night in T1/T2 (AC-H1.2)", () => {
    render(<TonightCardView state="T1" primary={go("Open movie night")} isNew />);
    expect(q("just-started")?.textContent).toBe("Just started");
    expect(q("tonight-announce")?.textContent).toBe("A new movie night just started.");
    render(<TonightCardView state="T1" primary={go("Open movie night")} />);
    expect(q("just-started")).toBeNull();
    expect(q("tonight-announce")?.textContent).toBe("");
    render(<TonightCardView state="T5" primary={go("See the winner")} isNew />);
    expect(q("just-started")).toBeNull();
  });
});

describe("helpers", () => {
  it("lists names the way people say them", () => {
    expect(listNames([])).toBe("");
    expect(listNames(["Lulu"])).toBe("Lulu");
    expect(listNames(["Lulu", "Bo"])).toBe("Lulu and Bo");
    expect(listNames(["Lulu", "Bo", "Max"])).toBe("Lulu, Bo and Max");
  });

  it("counts only ballots that hold picks as votes", () => {
    const ballots = [
      { person_id: "a", ranks: [{ option_id: "o1", rank: 1 }] },
      { person_id: "b", ranks: [] },
    ] as unknown as OwnBallot[];
    expect(castBallots(ballots).map((b) => b.person_id)).toEqual(["a"]);
    expect(castBallots(undefined)).toEqual([]);
  });
});
