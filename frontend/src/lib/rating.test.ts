import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SCORES,
  describeAverage,
  dismissRatePrompt,
  isRatePromptDismissed,
  unratedPeople,
} from "./rating";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("unratedPeople", () => {
  const people = [
    { id: "sam", binding: "mine" },
    { id: "ana", binding: "mine" },
    { id: "max", binding: "taken" },
    { id: "zed", binding: "pending" },
  ];

  it("lists this phone's people who have no score yet, in order", () => {
    const ratings = [
      { person_id: "sam", score: 4 },
      { person_id: "ana", score: null },
    ];
    expect(unratedPeople(people, ratings).map((p) => p.id)).toEqual(["ana"]);
  });

  it("treats a person missing from the ratings as unrated, and ignores other phones' people", () => {
    expect(unratedPeople(people, []).map((p) => p.id)).toEqual(["sam", "ana"]);
  });

  it("is empty once everyone here has rated", () => {
    const ratings = [
      { person_id: "sam", score: 1 },
      { person_id: "ana", score: 5 },
    ];
    expect(unratedPeople(people, ratings)).toEqual([]);
  });
});

describe("describeAverage", () => {
  it("rounds to one decimal and pluralises", () => {
    expect(describeAverage({ average: 13 / 3, count: 3 })).toBe("4.3 from 3 ratings");
    expect(describeAverage({ average: 5, count: 1 })).toBe("5.0 from 1 rating");
  });

  it("is null before ratings open or before anyone rates", () => {
    expect(describeAverage(null)).toBeNull();
    expect(describeAverage(undefined)).toBeNull();
    expect(describeAverage({ average: null, count: 0 })).toBeNull();
    expect(describeAverage({ average: 3, count: 0 })).toBeNull();
  });

  it("scores run 1..5", () => {
    expect(SCORES).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("the home card's Not now", () => {
  it("is remembered per night in localStorage", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    expect(isRatePromptDismissed("night-1")).toBe(false);
    dismissRatePrompt("night-1");
    expect(isRatePromptDismissed("night-1")).toBe(true);
    expect(isRatePromptDismissed("night-2")).toBe(false);
  });

  it("does nothing without a window (server render)", () => {
    expect(typeof window).toBe("undefined");
    dismissRatePrompt("night-1");
    expect(isRatePromptDismissed("night-1")).toBe(false);
  });

  it("survives storage that refuses access", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    dismissRatePrompt("night-1");
    expect(isRatePromptDismissed("night-1")).toBe(false);
  });

  it("survives storage whose calls throw", () => {
    const broken = memoryStorage();
    broken.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    broken.getItem = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("window", { localStorage: broken });
    expect(() => dismissRatePrompt("night-1")).not.toThrow();
    expect(isRatePromptDismissed("night-1")).toBe(false);
  });
});
