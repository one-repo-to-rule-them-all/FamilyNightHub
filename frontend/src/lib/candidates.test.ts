import { describe, expect, it } from "vitest";

import {
  AGE_CAPS,
  type Candidate,
  candidateKey,
  candidateMeta,
  clampCount,
  COUNT_DEFAULT,
  DEFAULT_ROLL,
  GENRES,
  isOnShortlist,
  parseMaxRuntime,
  slotsLeft,
  sourceLabel,
  toGenerateBody,
  toOptionIn,
} from "./candidates";

const base: Candidate = {
  movie_id: null,
  tmdb_id: null,
  title: "Up",
  year: 2009,
  poster_path: null,
  source: "tmdb",
  us_cert: "PG",
  runtime: 96,
  providers: [],
};
const owned: Candidate = { ...base, source: "owned", movie_id: "m-1", tmdb_id: 14160 };
const streaming: Candidate = {
  ...base,
  source: "streaming",
  tmdb_id: 862,
  providers: ["Disney Plus", "Netflix"],
};
const tmdb: Candidate = { ...base, tmdb_id: 12 };

describe("constants", () => {
  it("lists TMDB's 19 genres and the US caps mildest first", () => {
    expect(GENRES).toHaveLength(19);
    expect(AGE_CAPS).toEqual(["G", "PG", "PG-13", "R", "NC-17"]);
  });
});

describe("parseMaxRuntime", () => {
  it("is null when blank and the minutes when in range", () => {
    expect(parseMaxRuntime("")).toBeNull();
    expect(parseMaxRuntime("  ")).toBeNull();
    expect(parseMaxRuntime("30")).toBe(30);
    expect(parseMaxRuntime(" 120 ")).toBe(120);
    expect(parseMaxRuntime("400")).toBe(400);
  });

  it("is NaN outside 30..400 or when not a whole number", () => {
    expect(parseMaxRuntime("29")).toBeNaN();
    expect(parseMaxRuntime("401")).toBeNaN();
    expect(parseMaxRuntime("90.5")).toBeNaN();
    expect(parseMaxRuntime("abc")).toBeNaN();
  });
});

describe("clampCount", () => {
  it("keeps 1..20, rounds, and falls back to the default", () => {
    expect(clampCount(0)).toBe(1);
    expect(clampCount(25)).toBe(20);
    expect(clampCount(6.6)).toBe(7);
    expect(clampCount(Number.NaN)).toBe(COUNT_DEFAULT);
  });
});

describe("toGenerateBody", () => {
  it("omits age_cap for the night's cap and the optional filters when unset", () => {
    expect(toGenerateBody(DEFAULT_ROLL)).toEqual({ count: 12 });
    expect("age_cap" in toGenerateBody(DEFAULT_ROLL)!).toBe(false);
  });

  it("sends null for no cap tonight, or the override", () => {
    expect(toGenerateBody({ ...DEFAULT_ROLL, cap: "none" })).toEqual({ count: 12, age_cap: null });
    expect(toGenerateBody({ ...DEFAULT_ROLL, cap: "PG-13" })).toEqual({
      count: 12,
      age_cap: "PG-13",
    });
  });

  it("carries genre, runtime and a clamped count", () => {
    expect(toGenerateBody({ count: 40, genre: "Family", maxRuntime: "100", cap: "night" })).toEqual(
      { count: 20, genre: "Family", max_runtime: 100 },
    );
  });

  it("is null while the runtime is invalid", () => {
    expect(toGenerateBody({ ...DEFAULT_ROLL, maxRuntime: "10" })).toBeNull();
  });
});

describe("toOptionIn", () => {
  it("adds owned titles by library id, others by TMDB id with their source", () => {
    expect(toOptionIn(owned)).toEqual({ movie_id: "m-1" });
    expect(toOptionIn(streaming)).toEqual({ tmdb_id: 862, source: "streaming" });
    expect(toOptionIn(tmdb)).toEqual({ tmdb_id: 12, source: "tmdb" });
  });

  it("is null when the id the source needs is missing", () => {
    expect(toOptionIn({ ...owned, movie_id: null })).toBeNull();
    expect(toOptionIn({ ...streaming, tmdb_id: null })).toBeNull();
  });
});

describe("candidateKey", () => {
  it("prefers the library id, then the TMDB id, then title and year", () => {
    expect(candidateKey(owned)).toBe("movie:m-1");
    expect(candidateKey(streaming)).toBe("tmdb:862");
    expect(candidateKey(base)).toBe("title:Up:2009");
    expect(candidateKey({ ...base, year: null })).toBe("title:Up:");
  });
});

describe("sourceLabel", () => {
  it("names the badge per source", () => {
    expect(sourceLabel(owned)).toBe("Owned");
    expect(sourceLabel(streaming)).toBe("Streaming on Disney Plus, Netflix");
    expect(sourceLabel({ ...streaming, providers: [] })).toBe("Streaming");
    expect(sourceLabel(tmdb)).toBe("TMDB");
  });
});

describe("slotsLeft", () => {
  it("counts down to 0 at the 8-title limit and never goes negative", () => {
    expect(slotsLeft(0)).toBe(8);
    expect(slotsLeft(6)).toBe(2);
    expect(slotsLeft(8)).toBe(0);
    expect(slotsLeft(9)).toBe(0);
  });
});

describe("isOnShortlist", () => {
  const none = new Set<string>();

  it("is true once added from this roll", () => {
    expect(isOnShortlist(streaming, none, new Set(["tmdb:862"]))).toBe(true);
    expect(isOnShortlist(streaming, none, none)).toBe(false);
  });

  it("matches an owned title already on the shortlist by library id", () => {
    expect(isOnShortlist(owned, new Set(["m-1"]), none)).toBe(true);
    expect(isOnShortlist(owned, new Set(["m-2"]), none)).toBe(false);
    expect(isOnShortlist(tmdb, new Set(["m-1"]), none)).toBe(false);
  });
});

describe("candidateMeta", () => {
  it("joins the known year and runtime", () => {
    expect(candidateMeta(owned)).toBe("2009 · 96 min");
    expect(candidateMeta({ ...base, year: null, runtime: null })).toBe("");
  });
});
