import { describe, expect, it } from "vitest";

import { profileStats } from "./profile";

describe("profileStats", () => {
  const stats = {
    nights_joined: 4,
    ballots_cast: 3,
    winners_picked: 1,
    photos_uploaded: 7,
    ratings_given: 2,
    average_rating_given: 4.25,
  };

  it("lists every stat with a readable value", () => {
    expect(profileStats(stats)).toEqual([
      { label: "Movie nights", value: "4" },
      { label: "Votes cast", value: "3" },
      { label: "Winners picked", value: "1" },
      { label: "Photos added", value: "7" },
      { label: "Movies rated", value: "2" },
      { label: "Average rating", value: "4.3 ★" },
    ]);
  });

  it("shows a dash before anything is rated", () => {
    expect(profileStats({ ...stats, average_rating_given: null }).at(-1)?.value).toBe("—");
  });
});
