import { describe, expect, it } from "vitest";

import {
  ageCapSelectValue,
  markDirty,
  nightsPatch,
  passwordDirty,
  passwordPatch,
  saveLook,
  SETTINGS_GROUPS,
  streamingDirty,
  streamingPatch,
  visibleGroups,
} from "./groups";

describe("visibleGroups", () => {
  it("shows an admin every group, in order (AC-P5.1)", () => {
    expect(visibleGroups("admin").map((g) => g.id)).toEqual([
      "joining",
      "nights",
      "streaming",
      "account",
      "browser",
    ]);
    expect(visibleGroups("admin")).toEqual(SETTINGS_GROUPS);
  });

  it("shows a host only Your account and This browser (AC-P5.1)", () => {
    expect(visibleGroups("host").map((g) => g.label)).toEqual(["Your account", "This browser"]);
  });
});

describe("markDirty / saveLook", () => {
  it("makes the newest dirty group the one primary (AC-P5.2, rule 1)", () => {
    let order = markDirty([], "nights", true);
    expect(saveLook(order, "nights")).toBe("primary");
    expect(saveLook(order, "streaming")).toBe("idle");

    order = markDirty(order, "streaming", true);
    expect(order).toEqual(["nights", "streaming"]);
    expect(saveLook(order, "streaming")).toBe("primary");
    expect(saveLook(order, "nights")).toBe("secondary");
    expect(saveLook(order, "account")).toBe("idle");
  });

  it("moves a group that is edited again to the end", () => {
    expect(markDirty(["nights", "streaming"], "nights", true)).toEqual(["streaming", "nights"]);
  });

  it("returns the same order when nothing changes (no re-render loop)", () => {
    const order = ["nights", "streaming"] as const;
    expect(markDirty(order, "streaming", true)).toBe(order);
    expect(markDirty(order, "account", false)).toBe(order);
  });

  it("hands the primary back when the newest group is saved", () => {
    const order = markDirty(["nights", "streaming"], "streaming", false);
    expect(order).toEqual(["nights"]);
    expect(saveLook(order, "nights")).toBe("primary");
    expect(saveLook([], "nights")).toBe("idle");
  });
});

describe("nightsPatch", () => {
  const saved = { default_voting_method: "top3", default_age_cap: "PG-13" } as const;

  it("is empty when nothing changed", () => {
    expect(nightsPatch(saved, { method: "top3", ageCap: "PG-13" })).toEqual({});
  });

  it("sends only the fields that changed", () => {
    expect(nightsPatch(saved, { method: "approval", ageCap: "PG-13" })).toEqual({
      default_voting_method: "approval",
    });
    expect(nightsPatch(saved, { method: "top3", ageCap: "none" })).toEqual({
      default_age_cap: null,
    });
  });

  it("maps a saved null cap to the No cap option and back", () => {
    expect(ageCapSelectValue(null)).toBe("none");
    expect(ageCapSelectValue("R")).toBe("R");
    expect(
      nightsPatch(
        { default_voting_method: "pick_one", default_age_cap: null },
        {
          method: "pick_one",
          ageCap: "none",
        },
      ),
    ).toEqual({});
  });
});

describe("streamingPatch / streamingDirty", () => {
  const saved = { region: "US", streaming_providers: [8, 337] };

  it("is clean when the region only differs in case and the services in order", () => {
    const draft = { region: " us ", providers: [337, 8] };
    expect(streamingPatch(saved, draft)).toEqual({ body: {} });
    expect(streamingDirty(saved, draft)).toBe(false);
  });

  it("sends the normalised region and the new services", () => {
    expect(streamingPatch(saved, { region: "gb", providers: [8] })).toEqual({
      body: { region: "GB", streaming_providers: [8] },
    });
    expect(streamingDirty(saved, { region: "US", providers: [8] })).toBe(true);
  });

  it("rejects a region that isn't two letters, and counts it as unsaved", () => {
    const draft = { region: "USA", providers: [8, 337] };
    expect(streamingPatch(saved, draft)).toEqual({
      error: "Use a two-letter country code, like US or GB.",
    });
    expect(streamingDirty(saved, draft)).toBe(true);
  });
});

describe("passwordDirty / passwordPatch", () => {
  const empty = { current: "", next: "", confirm: "" };
  const good = "correct horse battery";

  it("is dirty as soon as anything is typed", () => {
    expect(passwordDirty(empty)).toBe(false);
    expect(passwordDirty({ ...empty, current: "x" })).toBe(true);
    expect(passwordDirty({ ...empty, next: "x" })).toBe(true);
    expect(passwordDirty({ ...empty, confirm: "x" })).toBe(true);
  });

  it("needs the current password to change one", () => {
    expect(passwordPatch(true, { current: "", next: good, confirm: good })).toEqual({
      error: "Type your current password.",
    });
    expect(passwordPatch(true, { current: "old one here!", next: good, confirm: good })).toEqual({
      body: { current_password: "old one here!", new_password: good },
    });
  });

  it("sets a first password without the current one", () => {
    expect(passwordPatch(false, { current: "", next: good, confirm: good })).toEqual({
      body: { new_password: good },
    });
  });

  it("passes on the shared password rules", () => {
    expect(passwordPatch(false, { current: "", next: "short", confirm: "short" })).toEqual({
      error: "Use at least 12 characters.",
    });
    expect(passwordPatch(false, { current: "", next: good, confirm: "different!!!!" })).toEqual({
      error: "The two passwords don't match.",
    });
  });
});
