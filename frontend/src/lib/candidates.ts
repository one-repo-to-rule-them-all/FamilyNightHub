/**
 * Pure logic for the host's "Roll candidates" panel (04-frontend.md "Host screens", ADR-0007).
 *
 * The generator only suggests: nothing is added until the host taps "Add to shortlist", which
 * goes through `POST .../options` with the option source that matches the candidate (03-backend.md
 * "Candidates"): `movie_id` for an owned title (the server derives `owned`), else `tmdb_id` plus
 * `source: "streaming" | "tmdb"`.
 */
import type { components } from "@/types/api.gen";

import { MAX_OPTIONS } from "./shortlist";

type Schemas = components["schemas"];
export type Candidate = Schemas["CandidateOut"];
export type GenerateBody = Schemas["GenerateIn"];
export type Genre = NonNullable<GenerateBody["genre"]>;
export type AgeCap = NonNullable<GenerateBody["age_cap"]>;

/** TMDB's 19 movie genres, as the API's `GenerateIn.genre` enum names them. */
export const GENRES: readonly Genre[] = [
  "Action",
  "Adventure",
  "Animation",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "History",
  "Horror",
  "Music",
  "Mystery",
  "Romance",
  "Science Fiction",
  "TV Movie",
  "Thriller",
  "War",
  "Western",
];

/** US certifications in ascending order (the cap is "this or milder"). */
export const AGE_CAPS: readonly AgeCap[] = ["G", "PG", "PG-13", "R", "NC-17"];

/**
 * The age cap choice: `"night"` keeps the night's cap (else the household default), `"none"` is
 * "no cap tonight", anything else overrides it for this roll.
 */
export type CapChoice = "night" | "none" | AgeCap;

export const COUNT_MIN = 1;
export const COUNT_MAX = 20;
export const COUNT_DEFAULT = 12;
export const RUNTIME_MIN = 30;
export const RUNTIME_MAX = 400;

export type RollForm = {
  count: number;
  genre: Genre | "";
  /** Minutes as typed; blank = any length. */
  maxRuntime: string;
  cap: CapChoice;
};

export const DEFAULT_ROLL: RollForm = {
  count: COUNT_DEFAULT,
  genre: "",
  maxRuntime: "",
  cap: "night",
};

/** The typed max runtime: null when blank, NaN when it is outside 30..400 or not a number. */
export function parseMaxRuntime(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const minutes = Number(trimmed);
  return Number.isInteger(minutes) && minutes >= RUNTIME_MIN && minutes <= RUNTIME_MAX
    ? minutes
    : Number.NaN;
}

export function clampCount(count: number): number {
  if (!Number.isFinite(count)) return COUNT_DEFAULT;
  return Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.round(count)));
}

/**
 * The request body, or null while the form is invalid. `age_cap` is omitted for the night's cap
 * (the API tells "omitted" from `null`, which is "no cap tonight").
 */
export function toGenerateBody(form: RollForm): GenerateBody | null {
  const maxRuntime = parseMaxRuntime(form.maxRuntime);
  if (Number.isNaN(maxRuntime)) return null;
  const body: GenerateBody = { count: clampCount(form.count) };
  if (form.genre) body.genre = form.genre;
  if (maxRuntime !== null) body.max_runtime = maxRuntime;
  if (form.cap === "none") body.age_cap = null;
  else if (form.cap !== "night") body.age_cap = form.cap;
  return body;
}

/** The `OptionIn` that adds this candidate with its source, or null if it can't be added. */
export function toOptionIn(candidate: Candidate): Schemas["OptionIn"] | null {
  if (candidate.source === "owned") {
    return candidate.movie_id ? { movie_id: candidate.movie_id } : null;
  }
  return candidate.tmdb_id === null
    ? null
    : { tmdb_id: candidate.tmdb_id, source: candidate.source };
}

/** A stable key: the library id for owned titles, else the TMDB id. */
export function candidateKey(candidate: Candidate): string {
  if (candidate.movie_id) return `movie:${candidate.movie_id}`;
  if (candidate.tmdb_id !== null) return `tmdb:${candidate.tmdb_id}`;
  return `title:${candidate.title}:${candidate.year ?? ""}`;
}

/** The badge: "Owned", "Streaming on Disney Plus, Netflix", or "TMDB". */
export function sourceLabel(candidate: Candidate): string {
  switch (candidate.source) {
    case "owned":
      return "Owned";
    case "streaming":
      return candidate.providers.length > 0
        ? `Streaming on ${candidate.providers.join(", ")}`
        : "Streaming";
    case "tmdb":
      return "TMDB";
  }
}

/** How many more titles the shortlist takes (voting needs 2..8). */
export function slotsLeft(optionCount: number): number {
  return Math.max(0, MAX_OPTIONS - optionCount);
}

/**
 * Whether this candidate is already on the shortlist: added from this roll (`added` keys), or an
 * owned title whose library row is already an option.
 */
export function isOnShortlist(
  candidate: Candidate,
  optionMovieIds: ReadonlySet<string>,
  added: ReadonlySet<string>,
): boolean {
  if (added.has(candidateKey(candidate))) return true;
  return candidate.movie_id !== null && optionMovieIds.has(candidate.movie_id);
}

/** The subtitle under a title: year and runtime, whichever are known (the cert is a badge). */
export function candidateMeta(candidate: Candidate): string {
  const parts: string[] = [];
  if (candidate.year) parts.push(String(candidate.year));
  if (candidate.runtime) parts.push(`${candidate.runtime} min`);
  return parts.join(" · ");
}
