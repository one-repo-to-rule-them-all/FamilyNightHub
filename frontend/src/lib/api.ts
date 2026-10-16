/**
 * Browser client for the FNH API (04-frontend.md "API client & types").
 *
 * - Same-origin `/api/*` (next.config.ts rewrites it to fnh-api), `credentials: "include"` so the
 *   httpOnly `fnh_device` / `fnh_session` cookies ride along.
 * - CSRF is double-submit (ADR-0002): GET /api/v1/csrf once, cache the token, and send it as
 *   `X-FNH-CSRF` on every mutation. A 403 CSRF rejection (cookie cleared or rotated) refreshes the
 *   token and retries once.
 * - Every non-2xx is the envelope `{"error": {code, message, request_id}}` (backend app/main.py),
 *   surfaced as `ApiError`. Screens show `message` as-is: the server already keeps it generic.
 *
 * Types come from src/types/api.gen.ts (generated from backend/openapi.json; never hand-edited).
 */
import type { components, operations } from "@/types/api.gen";

export type Schemas = components["schemas"];
export type Person = Schemas["PersonOut"];
export type Binding = Schemas["BindingOut"];
export type Device = Schemas["DeviceOut"];
export type JoinResult = Schemas["JoinOut"];
export type Account = Schemas["AccountOut"];
export type Night = Schemas["SessionOut"];
export type NightOption = Schemas["OptionOut"];
export type NightStatus = Night["status"];
export type NightSummary = Schemas["NightSummaryOut"];
export type OwnBallot = Schemas["OwnBallotOut"];
export type OwnRating = Schemas["OwnRatingOut"];
export type RatingSummary = Schemas["RatingSummaryOut"];
export type Voter = Schemas["VoterOut"];
export type TmdbResult = Schemas["TmdbResultOut"];
export type Claim = Schemas["ClaimOut"];
export type AdminPerson = Schemas["AdminPersonOut"];
export type AdminDevice = Schemas["AdminDeviceOut"];
export type MergeResult = Schemas["MergeOut"];
export type HouseholdSettings = Schemas["SettingsOut"];
export type AgeCap = NonNullable<HouseholdSettings["default_age_cap"]>;
export type StreamingProvider = Schemas["ProviderOut"];
export type Photo = Schemas["PhotoOut"];
export type PhotoCreated = Schemas["PhotoCreatedOut"];
/** The album's fixed reaction set (the path parameter's enum). */
export type ReactionEmoji =
  operations["add_reaction_api_v1_sessions__session_id__photos__photo_id__reactions__emoji__put"]["parameters"]["path"]["emoji"];

export const CSRF_HEADER = "X-FNH-CSRF";
const BASE = "/api/v1";
const NETWORK_MESSAGE = "Can't reach Family Night right now. Check your Wi-Fi and try again.";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  /** Seconds from the Retry-After header (429s), or null. */
  readonly retryAfter: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null = null,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);
let csrfToken: Promise<string> | null = null;

/** Test seam: swap the transport and forget the cached CSRF token. */
export function configureApi(options: { fetch?: FetchLike } = {}): void {
  fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  csrfToken = null;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Maps any non-2xx response onto ApiError, whether or not the body is the envelope. */
export async function toApiError(response: Response): Promise<ApiError> {
  const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON (a proxy error page, an empty 502): fall through to the generic message.
  }
  const envelope = (body as { error?: Record<string, unknown> } | null)?.error;
  if (envelope && typeof envelope.message === "string") {
    return new ApiError(
      response.status,
      typeof envelope.code === "string" ? envelope.code : "http_error",
      envelope.message,
      typeof envelope.request_id === "string" ? envelope.request_id : null,
      retryAfter,
    );
  }
  return new ApiError(response.status, "unknown_error", NETWORK_MESSAGE, null, retryAfter);
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(`${BASE}${path}`, { ...init, credentials: "include" });
  } catch {
    throw new ApiError(0, "network_error", NETWORK_MESSAGE);
  }
}

function fetchCsrfToken(): Promise<string> {
  if (!csrfToken) {
    csrfToken = (async () => {
      const response = await send("/csrf", { method: "GET" });
      if (!response.ok) throw await toApiError(response);
      const body = (await response.json()) as Schemas["CsrfOut"];
      return body.csrf_token;
    })();
    // A failed fetch must not poison every later mutation.
    csrfToken.catch(() => {
      csrfToken = null;
    });
  }
  return csrfToken;
}

function isCsrfRejection(error: ApiError): boolean {
  return error.status === 403 && error.message.startsWith("CSRF");
}

async function request<T>(method: Method, path: string, body?: unknown, retried = false) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers[CSRF_HEADER] = await fetchCsrfToken();

  const response = await send(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await toApiError(response);
    if (!retried && method !== "GET" && isCsrfRejection(error)) {
      csrfToken = null;
      return request<T>(method, path, body, true);
    }
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** One function per endpoint the UI uses, typed from the generated schema. */
export const api = {
  join: (body: Schemas["JoinIn"]) => request<JoinResult>("POST", "/join", body),
  people: () => request<Person[]>("GET", "/people"),
  myDevice: () => request<Device>("GET", "/devices/me"),
  claimPerson: (personId: string) =>
    request<Binding>("PUT", `/devices/me/people/${encodeURIComponent(personId)}`),
  releasePerson: (personId: string) =>
    request<void>("DELETE", `/devices/me/people/${encodeURIComponent(personId)}`),
  requestMagicLink: (body: Schemas["MagicLinkIn"]) =>
    request<Schemas["MagicLinkOut"]>("POST", "/auth/magic-link", body),
  verifyMagicLink: (body: Schemas["VerifyIn"]) => request<Account>("POST", "/auth/verify", body),
  me: () => request<Account>("GET", "/auth/me"),
  logout: () => request<void>("POST", "/auth/logout"),
  /** The night as every screen sees it (no ballots; `result` only from reveal on). */
  night: (sessionId: string) => request<Night>("GET", `/sessions/${encodeURIComponent(sessionId)}`),
  /** Nights newest first; the server defaults to revealed, tonight and closed (history). */
  nights: (options: { status?: NightStatus[]; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const status of options.status ?? []) query.append("status", status);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return request<NightSummary[]>("GET", `/sessions${suffix}`);
  },
  myBallots: (sessionId: string) =>
    request<OwnBallot[]>("GET", `/sessions/${encodeURIComponent(sessionId)}/ballots/mine`),
  castBallot: (sessionId: string, body: Schemas["BallotIn"]) =>
    request<void>("PUT", `/sessions/${encodeURIComponent(sessionId)}/ballots`, body),
  /** Scores of the people this phone holds (null until each has rated). */
  myRatings: (sessionId: string) =>
    request<OwnRating[]>("GET", `/sessions/${encodeURIComponent(sessionId)}/ratings/mine`),
  /** Rate (or re-rate) the night 1–5 as a person this phone holds; open from `tonight` on. */
  rate: (sessionId: string, body: Schemas["RatingIn"]) =>
    request<void>("PUT", `/sessions/${encodeURIComponent(sessionId)}/ratings`, body),

  /** A 60s single-use ticket for this night's live stream (ADR-0004). */
  sseTicket: (sessionId: string) =>
    request<Schemas["SseTicketOut"]>("POST", "/sse-tickets", { session_id: sessionId }),

  // Nights (host + TV screens). Mutations are host-only; reads work for any household viewer.
  createNight: (body: Schemas["SessionCreateIn"]) =>
    request<Schemas["SessionCreatedOut"]>("POST", "/sessions", body),
  rotateNightCode: (sessionId: string) =>
    request<Schemas["NightCodeOut"]>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/night-code`,
    ),
  addOption: (sessionId: string, body: Schemas["OptionIn"]) =>
    request<Night>("POST", `/sessions/${encodeURIComponent(sessionId)}/options`, body),
  removeOption: (sessionId: string, optionId: string) =>
    request<Night>(
      "DELETE",
      `/sessions/${encodeURIComponent(sessionId)}/options/${encodeURIComponent(optionId)}`,
    ),
  reorderOptions: (sessionId: string, optionIds: string[]) =>
    request<Night>("PUT", `/sessions/${encodeURIComponent(sessionId)}/options/order`, {
      option_ids: optionIds,
    }),
  openVoting: (sessionId: string) =>
    request<Night>("POST", `/sessions/${encodeURIComponent(sessionId)}/open-voting`),
  closeVoting: (sessionId: string) =>
    request<Night>("POST", `/sessions/${encodeURIComponent(sessionId)}/close-voting`),
  closeNight: (sessionId: string) =>
    request<Night>("POST", `/sessions/${encodeURIComponent(sessionId)}/close`),
  voters: (sessionId: string) =>
    request<Schemas["VotersOut"]>("GET", `/sessions/${encodeURIComponent(sessionId)}/voters`),
  proxyBallot: (sessionId: string, body: Schemas["BallotIn"]) =>
    request<void>("PUT", `/sessions/${encodeURIComponent(sessionId)}/ballots/proxy`, body),
  /** Roll candidates for a draft night (ADR-0007). Nothing is added; picks go via addOption. */
  generate: (sessionId: string, body: Schemas["GenerateIn"]) =>
    request<Schemas["GenerateOut"]>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/generate`,
      body,
    ),
  searchTmdb: (q: string) =>
    request<TmdbResult[]>("GET", `/tmdb/search?${new URLSearchParams({ q }).toString()}`),

  // Host device actions (ADR-0002).
  claims: () => request<Claim[]>("GET", "/devices/claims"),
  approveClaim: (deviceId: string, personId: string) =>
    request<void>(
      "POST",
      `/devices/${encodeURIComponent(deviceId)}/people/${encodeURIComponent(personId)}/approve`,
    ),
  rejectClaim: (deviceId: string, personId: string) =>
    request<void>(
      "POST",
      `/devices/${encodeURIComponent(deviceId)}/people/${encodeURIComponent(personId)}/reject`,
    ),
  enroll: (body: Schemas["EnrollIn"]) =>
    request<Schemas["EnrollOut"]>("POST", "/devices/enroll", body),

  // The night's photo album (ADR-0005).
  /** The album, newest first. Every URL is a presigned GET that expires in 10 minutes. */
  photos: (sessionId: string) =>
    request<Photo[]>("GET", `/sessions/${encodeURIComponent(sessionId)}/photos`),
  /** A pending photo plus presigned PUTs (5 min) for the JPEG and its thumbnail. */
  createPhoto: (sessionId: string, body: Schemas["PhotoCreateIn"]) =>
    request<PhotoCreated>("POST", `/sessions/${encodeURIComponent(sessionId)}/photos`, body),
  completePhoto: (sessionId: string, photoId: string) =>
    request<void>("POST", `${photoPath(sessionId, photoId)}/complete`),
  react: (sessionId: string, photoId: string, emoji: ReactionEmoji, personId: string) =>
    request<void>("PUT", reactionPath(sessionId, photoId, emoji, personId)),
  unreact: (sessionId: string, photoId: string, emoji: ReactionEmoji, personId: string) =>
    request<void>("DELETE", reactionPath(sessionId, photoId, emoji, personId)),

  // Admin (`/admin/*`, 03-backend.md "People and devices admin"). Account-only; the API answers
  // 403 to a host without the permission, which the admin screens show as "admins only".
  adminPeople: () => request<AdminPerson[]>("GET", "/admin/people"),
  createPerson: (body: Schemas["PersonCreateIn"]) =>
    request<AdminPerson>("POST", "/admin/people", body),
  updatePerson: (personId: string, body: Schemas["PersonUpdateIn"]) =>
    request<AdminPerson>("PATCH", `/admin/people/${encodeURIComponent(personId)}`, body),
  convertToMember: (personId: string) =>
    request<AdminPerson>("POST", `/admin/people/${encodeURIComponent(personId)}/convert-to-member`),
  /** Folds `from` into `into`; the source is hidden (merged_into_id), never deleted. */
  mergePeople: (body: Schemas["MergeIn"]) =>
    request<MergeResult>("POST", "/admin/people/merge", body),
  adminDevices: () => request<AdminDevice[]>("GET", "/admin/devices"),
  /** `label: null` clears it. */
  updateDevice: (deviceId: string, label: string | null) =>
    request<AdminDevice>("PATCH", `/admin/devices/${encodeURIComponent(deviceId)}`, { label }),
  /** Final: there is no un-revoke; the phone rejoins with a night code as a new device. */
  revokeDevice: (deviceId: string) =>
    request<AdminDevice>("POST", `/admin/devices/${encodeURIComponent(deviceId)}/revoke`),
  settings: () => request<HouseholdSettings>("GET", "/admin/settings"),
  updateSettings: (body: Schemas["SettingsUpdateIn"]) =>
    request<HouseholdSettings>("PATCH", "/admin/settings", body),
  /** `/j/{old}` stops resolving at once; the printed fridge QR needs reprinting. */
  rotateJoinSlug: () => request<Schemas["JoinSlugOut"]>("POST", "/admin/join-slug/rotate"),
  /** Streaming services in the household's region (JustWatch data: show `attribution`). */
  streamingProviders: () => request<Schemas["ProvidersOut"]>("GET", "/tmdb/providers"),
};

/** The live stream URL for `EventSource`: the ticket is the credential (no cookie, no CSRF). */
export function liveStreamUrl(sessionId: string, ticket: string): string {
  const query = new URLSearchParams({ ticket }).toString();
  return `${BASE}/sessions/${encodeURIComponent(sessionId)}/stream?${query}`;
}

/**
 * Enrolls this browser (ADR-0002) and resolves once the new device cookie actually works.
 *
 * The API commits the enroll in a request-scoped dependency, which can finish after the response
 * has reached the browser, so the very next device request may still get a 401. Waiting on
 * `GET /devices/me` here keeps every caller (TV pairing, the host's proxy-vote list) from racing it.
 */
export async function enrollDevice(
  body: Schemas["EnrollIn"],
  { attempts = 20, delayMs = 150 }: { attempts?: number; delayMs?: number } = {},
): Promise<Schemas["EnrollOut"]> {
  const enrolled = await api.enroll(body);
  for (let attempt = 1; ; attempt++) {
    try {
      await api.myDevice();
      return enrolled;
    } catch (error) {
      const notYet = error instanceof ApiError && error.status === 401;
      if (!notYet || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function photoPath(sessionId: string, photoId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(photoId)}`;
}

function reactionPath(sessionId: string, photoId: string, emoji: string, personId: string) {
  const query = new URLSearchParams({ person_id: personId });
  return `${photoPath(sessionId, photoId)}/reactions/${encodeURIComponent(emoji)}?${query}`;
}

/** "Try again in 2 minutes." for a 429, or null when the server gave no Retry-After. */
export function retryAfterHint(error: ApiError): string | null {
  if (error.status !== 429 || error.retryAfter === null) return null;
  const seconds = error.retryAfter;
  if (seconds < 60)
    return `Try again in ${Math.max(1, seconds)} second${seconds === 1 ? "" : "s"}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
