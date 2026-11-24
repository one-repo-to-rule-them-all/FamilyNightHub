// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProfileNight } from "@/lib/api";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { nightBadges, RecentNightsList } = await import("./recent-nights");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const night = (i: number, extra: Partial<ProfileNight> = {}): ProfileNight => ({
  session_id: `n${i}`,
  date: "2026-10-17",
  title: null,
  status: "closed",
  voting_method: "top3",
  picks: [],
  picked_winner: false,
  rating: null,
  photo_count: 0,
  attended: true,
  winner: { id: `m${i}`, title: `Movie ${i}`, poster_path: null, year: null },
  ...extra,
});

describe("RecentNightsList (§5 H1 item 4)", () => {
  it("shows the newest three, each linking to its night, then See all my nights (AC-H1.7)", () => {
    act(() => root.render(<RecentNightsList nights={[1, 2, 3, 4, 5].map((i) => night(i))} />));
    const rows = host.querySelectorAll<HTMLAnchorElement>('[data-testid="recent-night"]');
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute("href")).toBe("/s/n1");
    expect(rows[0].textContent).toContain("Movie 1");
    expect(q("recent-all")?.getAttribute("href")).toBe("/history?tab=mine");
    expect(q("recent-all")?.textContent).toBe("See all my nights");
  });

  it("says so when there are no nights yet, with no button", () => {
    act(() => root.render(<RecentNightsList nights={[]} />));
    expect(q("recent-empty")?.textContent).toBe(
      "Your movie nights will show up here after the first one.",
    );
    expect(q("recent-all")).toBeNull();
    expect(host.querySelector("a")).toBeNull();
  });

  it("badges a winning pick and a rating", () => {
    act(() =>
      root.render(<RecentNightsList nights={[night(1, { picked_winner: true, rating: 4 })]} />),
    );
    expect(q("recent-night")?.textContent).toContain("🏆 Your pick won");
    expect(q("recent-night")?.textContent).toContain("You rated ★4");
  });
});

describe("nightBadges", () => {
  it("offers Rate it only once ratings are open", () => {
    expect(nightBadges({ picked_winner: false, rating: null, status: "closed" })).toEqual([
      "Rate it",
    ]);
    expect(nightBadges({ picked_winner: false, rating: null, status: "tonight" })).toEqual([
      "Rate it",
    ]);
    expect(nightBadges({ picked_winner: false, rating: null, status: "revealed" })).toEqual([]);
    expect(nightBadges({ picked_winner: true, rating: 5, status: "closed" })).toEqual([
      "Your pick won",
      "You rated ★5",
    ]);
  });
});
