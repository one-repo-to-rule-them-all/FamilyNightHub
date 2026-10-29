/**
 * Browser client for the FNH API (04-frontend.md "API client & types").
 *
 * - Same-origin `/api/*` (next.config.ts rewrites it to fnh-api), `credentials: "include"` so the
 *   httpOnly `fnh_device` / `fnh_session` cookies ride along.
 * - CSRF is double-submit (ADR-0002): GET /api/v1/csrf once, cache the token, and send it as
 *   `X-FNH-CSRF` on every mutation. A 403 CSRF rejection (cookie cleared or rotated) refreshes the
 *   token and retries once.
 * - On the TV screens (`/tv/*`) every request also sends `X-FNH-Device-Only: 1`, so it runs as the
 *   TV device even when the host is signed in in another window of the same browser (ADR-0002
 *   amendment 2026-10-18). The API then ignores `fnh_session` for that request.
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
export type VotingMethod = Night["voting_method"];
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
export type Removal = Schemas["RemovalOut"];
export type StartFreshResult = Schemas["StartFreshOut"];
export type HouseholdSettings = Schemas["SettingsOut"];
export type AgeCap = NonNullable<HouseholdSettings["default_age_cap"]>;
export type StreamingProvider = Schemas["ProviderOut"];
export type Photo = Schemas["PhotoOut"];
export type AdminMovie = Schemas["AdminMovieOut"];
export type MoviePage = Schemas["MoviePageOut"];
export type MovieFlags = Schemas["MovieFlagsIn"];
export type BulkResult = Schemas["BulkResultOut"];
export type BulkLine = Schemas["BulkLineOut"];
export type BulkPick = Schemas["BulkPickIn"];
export type TypedTitle = Schemas["TypedTitleIn"];
export type PhotoCreated = Schemas["PhotoCreatedOut"];
export type PinReset = Schemas["PinResetOut"];
export type AdminAccount = Schemas["AdminAccountOut"];
export type AccountRole = AdminAccount["role"];
export type Profile = Schemas["ProfileOut"];
export type ProfileNight = Schemas["ProfileNightOut"];

/** A tile on the avatar grid; `pin_reset` says a PIN reset is open or approved here (G2). */
export type PersonTile = Person;
export type PinResetState = Person["pin_reset"];
/** GET /devices/me/join-link (G1): what the TV needs to draw its QR. */
export type JoinLink = Schemas["JoinLinkOut"];
/** GET /sessions/{id}/present (G8): who is here tonight. Avatars and a voted flag, never picks. */
export type PresentPerson = Schemas["PresentOut"];
/** The album's fixed reaction set (the path parameter's enum). */
export type ReactionEmoji =
  operations["add_reaction_api_v1_sessions__session_id__photos__photo_id__reactions__emoji__put"]["parameters"]["path"]["emoji"];

export const CSRF_HEADER = "X-FNH-CSRF";
export const DEVICE_ONLY_HEADER = "X-FNH-Device-Only";

/** The TV screens run on the device cookie alone (see the header comment). */
export function onTvScreen(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname;
  return path === "/tv" || path.startsWith("/tv/");
}
const BASE = "/api/v1";
const NETWORK_MESSAGE = "Can't reach Family Night right now. Check your Wi-Fi and try again.";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  /** Seconds from the Retry-After header (429s), or null. */
  readonly retryAfter: number | null;
  /** PIN tries left before the person locks (`wrong_pin` / `pin_locked`, ADR-0014), or null. */
  readonly attemptsLeft: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null = null,
    retryAfter: number | null = null,
    attemptsLeft: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
    this.attemptsLeft = attemptsLeft;
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
      typeof envelope.attempts_left === "number" ? envelope.attempts_left : null,
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
  if (onTvScreen()) headers[DEVICE_ONLY_HEADER] = "1";

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
  people: () => request<PersonTile[]>("GET", "/people"),
  myDevice: () => request<Device>("GET", "/devices/me"),
  /**
   * Claim a person or switch to one this phone holds (ADR-0014). `pin` is their PIN, or the new
   * one on a first claim; leave it out to ask a host instead (the claim goes `pending`).
   */
  claimPerson: (personId: string, pin?: string) =>
    request<Binding>(
      "PUT",
      `/devices/me/people/${encodeURIComponent(personId)}`,
      pin === undefined ? undefined : { pin },
    ),
  releasePerson: (personId: string) =>
    request<void>("DELETE", `/devices/me/people/${encodeURIComponent(personId)}`),
  /** A new guest profile, current on this phone, with its PIN set in the same request. */
  createSelf: (body: Schemas["SelfCreateIn"]) =>
    request<Person>("POST", "/devices/me/people", body),
  /** Your own display name, once (409 after that). */
  renameSelf: (personId: string, name: string) =>
    request<Person>("PATCH", `/devices/me/people/${encodeURIComponent(personId)}`, { name }),
  /** Your own name (once) and/or picture (`avatar_emoji`, `color`; any number of times). */
  updateSelf: (personId: string, body: Schemas["UpdateSelfIn"]) =>
    request<Person>("PATCH", `/devices/me/people/${encodeURIComponent(personId)}`, body),
  /** Set a first PIN for someone this phone holds, or change it with `current_pin`. */
  setPin: (personId: string, body: Schemas["SetPinIn"]) =>
    request<Binding>("POST", `/devices/me/people/${encodeURIComponent(personId)}/pin`, body),
  /** Ask the family admin to reset a PIN; repeating it while one is open returns that one. */
  forgotPin: (personId: string) =>
    request<Schemas["PinResetRequestOut"]>(
      "POST",
      `/devices/me/people/${encodeURIComponent(personId)}/forgot-pin`,
    ),
  /** History and stats. Ballots only for revealed nights (ADR-0014 "Profiles"). */
  profile: (personId: string) =>
    request<Profile>("GET", `/people/${encodeURIComponent(personId)}/profile`),
  /** The TV's join door and the code-in-QR setting (G1; TV devices only). */
  joinLink: () => request<JoinLink>("GET", "/devices/me/join-link"),
  /** The TV's "waiting for the host" nudge (G4): pending person claims only, never PIN resets. */
  helpCount: () => request<Schemas["HelpCountOut"]>("GET", "/devices/me/help-count"),
  /** Username (or email) + password; sets the `fnh_session` cookie (ADR-0014). */
  login: (body: Schemas["LoginIn"]) => request<Account>("POST", "/auth/login", body),
  setPassword: (body: Schemas["PasswordIn"]) => request<void>("POST", "/auth/password", body),
  /** Forgot password: emails a link that sets a new one. */
  requestMagicLink: (body: Schemas["MagicLinkIn"]) =>
    request<Schemas["MagicLinkOut"]>("POST", "/auth/magic-link", body),
  /** Consumes the emailed link: sets `new_password` and signs in. */
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
  /** Change a draft night's voting method (ADR-0010); 409 once voting has opened. */
  setVotingMethod: (sessionId: string, votingMethod: VotingMethod) =>
    request<Night>("PATCH", `/sessions/${encodeURIComponent(sessionId)}`, {
      voting_method: votingMethod,
    }),
  openVoting: (sessionId: string) =>
    request<Night>("POST", `/sessions/${encodeURIComponent(sessionId)}/open-voting`),
  closeVoting: (sessionId: string) =>
    request<Night>("POST", `/sessions/${encodeURIComponent(sessionId)}/close-voting`),
  closeNight: (sessionId: string) =>
    request<Night>("POST", `/sessions/${encodeURIComponent(sessionId)}/close`),
  /** The host's Start (`true`) / Stop (`false`) for the paired TV's slideshow (issue #41). */
  setSlideshow: (sessionId: string, playing: boolean) =>
    request<Night>("PUT", `/sessions/${encodeURIComponent(sessionId)}/slideshow`, { playing }),
  voters: (sessionId: string) =>
    request<Schemas["VotersOut"]>("GET", `/sessions/${encodeURIComponent(sessionId)}/voters`),
  /** Who is here tonight (G8). */
  present: (sessionId: string) =>
    request<Schemas["PresenceOut"]>("GET", `/sessions/${encodeURIComponent(sessionId)}/present`),
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
  /** Clears the PIN, count and lock, locked or not, and closes any open request as approved.
   *  No PIN is set or shown: the person picks a new one on their phone (`admin:people`). */
  resetPin: (personId: string) =>
    request<AdminPerson>("POST", `/admin/people/${encodeURIComponent(personId)}/reset-pin`),
  /** What removing this person would delete (#94), for the confirm dialog. */
  removalPreview: (personId: string) =>
    request<Removal>("GET", `/admin/people/${encodeURIComponent(personId)}/removal`),
  /** Deletes the person and everything that is theirs (#94). Past winners stay. Can't be undone. */
  removePerson: (personId: string) =>
    request<Removal>("DELETE", `/admin/people/${encodeURIComponent(personId)}`),
  /** Clears every person, phone/TV and night (#94); the admin types the family name to confirm. */
  startFresh: (confirmName: string) =>
    request<StartFreshResult>("POST", "/admin/start-fresh", { confirm_name: confirmName }),
  /** Folds `from` into `into`; the source is hidden (merged_into_id), never deleted. */
  mergePeople: (body: Schemas["MergeIn"]) =>
    request<MergeResult>("POST", "/admin/people/merge", body),
  /** Open "Forgot PIN" requests, oldest first (`admin:people`; hosts get 403). */
  pinResets: () => request<PinReset[]>("GET", "/admin/people/pin-resets"),
  /** The admin nav badge (G4): how many PIN resets are open. */
  pinResetCount: () =>
    request<Schemas["PinResetCountOut"]>("GET", "/admin/people/pin-resets/count"),
  /** Clears the PIN, count and lock. No PIN is set or shown: the asking phone picks a new one. */
  approvePinReset: (requestId: string) =>
    request<PinReset>("POST", `/admin/people/pin-resets/${encodeURIComponent(requestId)}/approve`),
  dismissPinReset: (requestId: string) =>
    request<PinReset>("POST", `/admin/people/pin-resets/${encodeURIComponent(requestId)}/dismiss`),
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

  /** Admin library (`admin:movies`): search + flag filters (undefined = either), paginated. */
  adminMovies: (filters: {
    q?: string;
    owned?: boolean;
    watchlist?: boolean;
    blocked?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return request<MoviePage>("GET", `/admin/movies${suffix}`);
  },
  updateMovie: (movieId: string, flags: MovieFlags) =>
    request<AdminMovie>("PATCH", `/admin/movies/${encodeURIComponent(movieId)}`, flags),
  bulkAddMovies: (titles: TypedTitle[]) =>
    request<BulkResult>("POST", "/admin/movies/bulk", { titles }),
  confirmBulkMovies: (picks: BulkPick[]) =>
    request<BulkResult>("POST", "/admin/movies/bulk/confirm", { picks }),
  // Hosts and admins (issue #71, `admin:accounts`). The invite link is emailed, never returned.
  adminAccounts: () => request<AdminAccount[]>("GET", "/admin/accounts"),
  inviteAccount: (body: Schemas["AccountInviteIn"]) =>
    request<AdminAccount>("POST", "/admin/accounts", body),
  resendInvite: (accountId: string) =>
    request<AdminAccount>("POST", `/admin/accounts/${encodeURIComponent(accountId)}/resend`),
  /** 409 when it would leave the household without an admin. */
  changeAccountRole: (accountId: string, role: AccountRole) =>
    request<AdminAccount>("PATCH", `/admin/accounts/${encodeURIComponent(accountId)}`, { role }),
  removeAccount: (accountId: string) =>
    request<void>("DELETE", `/admin/accounts/${encodeURIComponent(accountId)}`),
  /** History edit (`admin:history`): re-point the winner; the ranking stays as voted. */
  correctWinner: (sessionId: string, body: Schemas["CorrectWinnerIn"]) =>
    request<Night>("POST", `/admin/sessions/${encodeURIComponent(sessionId)}/correct-winner`, body),
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
