import { describe, expect, it } from "vitest";

import type { ProfileNight } from "@/lib/api";

import { canRate, historyTab, mineSummary, picksLine } from "./history";

const pick = (title: string, rank: number) => ({
  option_id: `o-${title}`,
  rank,
  movie: { title, poster_path: null } as ProfileNight["picks"][number]["movie"],
});

describe("historyTab", () => {
  it("defaults to Mine", () => {
    expect(historyTab(null)).toBe("mine");
    expect(historyTab(undefined)).toBe("mine");
    expect(historyTab("nonsense")).toBe("mine");
    expect(historyTab("mine")).toBe("mine");
  });
  it("reads Family", () => {
    expect(historyTab("family")).toBe("family");
  });
});

describe("mineSummary", () => {
  it("is nights · winning picks · ★ average", () => {
    expect(
      mineSummary({ nights_joined: 12, winners_picked: 5, average_rating_given: 4.25 }),
    ).toEqual([
      { value: "12", label: "nights" },
      { value: "5", label: "winning picks" },
      { prefix: "★", value: "4.3", label: "average" },
    ]);
  });
  it("is singular for one, and drops the average until there is one", () => {
    expect(
      mineSummary({ nights_joined: 1, winners_picked: 1, average_rating_given: null }),
    ).toEqual([
      { value: "1", label: "night" },
      { value: "1", label: "winning pick" },
    ]);
  });
});

describe("picksLine", () => {
  it("lists the top three in rank order", () => {
    const picks = [pick("Up", 3), pick("Moana", 1), pick("Coco", 4), pick("Spirited Away", 2)];
    expect(picksLine({ picks, voting_method: "top3" })).toBe(
      "Your picks: Moana, Spirited Away, Up",
    );
  });
  it("counts approvals instead", () => {
    const picks = [pick("Up", 1), pick("Moana", 2)];
    expect(picksLine({ picks, voting_method: "approval" })).toBe("You liked 2");
  });
  it("is null with no ballot", () => {
    expect(picksLine({ picks: [], voting_method: "pick_one" })).toBeNull();
  });
});

describe("canRate", () => {
  it("offers Rate it on an unrated tonight or closed night", () => {
    expect(canRate({ status: "tonight", rating: null })).toBe(true);
    expect(canRate({ status: "closed", rating: null })).toBe(true);
  });
  it("not once rated, nor before tonight", () => {
    expect(canRate({ status: "closed", rating: 4 })).toBe(false);
    expect(canRate({ status: "revealed", rating: null })).toBe(false);
  });
});
