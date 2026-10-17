// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { recallLastJoin, rejoinLabel, rememberLastJoin } from "./last-join";

afterEach(() => window.localStorage.clear());

describe("last join (localStorage)", () => {
  it("remembers the slug and household name, never a code", () => {
    rememberLastJoin({ slug: "baez", householdName: "The Baez Family" });
    expect(recallLastJoin()).toEqual({ slug: "baez", householdName: "The Baez Family" });
    expect(window.localStorage.getItem("fnh.lastJoin")).not.toMatch(/code/i);
  });

  it("ignores missing or garbled values", () => {
    expect(recallLastJoin()).toBeNull();
    window.localStorage.setItem("fnh.lastJoin", "{not json");
    expect(recallLastJoin()).toBeNull();
    window.localStorage.setItem("fnh.lastJoin", JSON.stringify({ slug: "" }));
    expect(recallLastJoin()).toBeNull();
    window.localStorage.setItem("fnh.lastJoin", JSON.stringify({ slug: "baez", householdName: 3 }));
    expect(recallLastJoin()).toEqual({ slug: "baez", householdName: null });
  });

  it("labels the rejoin button with the household", () => {
    expect(rejoinLabel({ slug: "baez", householdName: "The Baez Family" })).toBe(
      "Join The Baez Family",
    );
    expect(rejoinLabel({ slug: "baez", householdName: null })).toBe("Join movie night");
  });
});
