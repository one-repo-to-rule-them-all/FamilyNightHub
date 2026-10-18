import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  ApiError,
  configureApi,
  CSRF_HEADER,
  DEVICE_ONLY_HEADER,
  enrollDevice,
  retryAfterHint,
  toApiError,
} from "./api";

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function envelope(code: string, message: string, requestId = "req-1") {
  return { error: { code, message, request_id: requestId } };
}

/** A scripted transport: answers in order and records every call. */
function transport(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  configureApi({ fetch });
  return calls;
}

const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

beforeEach(() => configureApi());
afterEach(() => configureApi());

describe("PIN errors (ADR-0014)", () => {
  it("carries attempts_left from the envelope and sends the PIN in the body", async () => {
    const calls = transport(
      json(200, { csrf_token: "tok-1" }),
      json(403, {
        error: { code: "wrong_pin", message: "Wrong PIN.", request_id: "r", attempts_left: 2 },
      }),
    );
    const error = await api.claimPerson("p", "123456").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "wrong_pin", attemptsLeft: 2 });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ pin: "123456" });
  });

  it("leaves attemptsLeft null on other errors", async () => {
    const error = await toApiError(json(404, envelope("http_error", "Person not found")));
    expect(error.attemptsLeft).toBeNull();
  });
});

describe("CSRF", () => {
  it("fetches the token once and sends it on every mutation", async () => {
    const calls = transport(
      json(200, { csrf_token: "tok-1" }),
      json(200, { household_name: "Baez", session_id: "s", device_id: "d" }),
      json(200, { person_id: "p", status: "active" }),
    );

    await api.join({ slug: "baez", night_code: "ABC234" });
    await api.claimPerson("p");

    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET /api/v1/csrf",
      "POST /api/v1/join",
      "PUT /api/v1/devices/me/people/p",
    ]);
    expect(header(calls[1], CSRF_HEADER)).toBe("tok-1");
    expect(header(calls[2], CSRF_HEADER)).toBe("tok-1");
    expect(calls.every((c) => c.init.credentials === "include")).toBe(true);
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      slug: "baez",
      night_code: "ABC234",
    });
  });

  it("shares one in-flight token fetch between concurrent mutations", async () => {
    const calls = transport(
      json(200, { csrf_token: "tok-1" }),
      json(200, { person_id: "a", status: "active" }),
      json(200, { person_id: "b", status: "pending" }),
    );

    await Promise.all([api.claimPerson("a"), api.claimPerson("b")]);

    expect(calls.filter((c) => c.url.endsWith("/csrf"))).toHaveLength(1);
  });

  it("does not send the header (or fetch a token) on reads", async () => {
    const calls = transport(json(200, []));

    await api.people();

    expect(calls).toHaveLength(1);
    expect(header(calls[0], CSRF_HEADER)).toBeUndefined();
  });

  it("refreshes the token and retries once when the server rejects it", async () => {
    const calls = transport(
      json(200, { csrf_token: "stale" }),
      json(403, envelope("http_error", "CSRF token missing or invalid")),
      json(200, { csrf_token: "fresh" }),
      json(202, { detail: "sent" }),
    );

    await expect(api.requestMagicLink({ email: "a@b.test" })).resolves.toEqual({ detail: "sent" });
    expect(header(calls[1], CSRF_HEADER)).toBe("stale");
    expect(header(calls[3], CSRF_HEADER)).toBe("fresh");
  });

  it("gives up after one retry", async () => {
    transport(
      json(200, { csrf_token: "t1" }),
      json(403, envelope("http_error", "CSRF token missing or invalid")),
      json(200, { csrf_token: "t2" }),
      json(403, envelope("http_error", "CSRF token missing or invalid")),
    );

    await expect(api.logout()).rejects.toMatchObject({ status: 403 });
  });

  it("does not retry a 403 that is not about CSRF", async () => {
    const calls = transport(
      json(200, { csrf_token: "t1" }),
      json(403, envelope("http_error", "Hosts only")),
    );

    await expect(api.logout()).rejects.toMatchObject({ status: 403, message: "Hosts only" });
    expect(calls).toHaveLength(2);
  });

  it("forgets a failed token fetch so the next mutation tries again", async () => {
    transport(new TypeError("offline"));
    await expect(api.logout()).rejects.toMatchObject({ code: "network_error" });

    const calls = transport(json(200, { csrf_token: "t" }), json(204, null));
    await expect(api.logout()).resolves.toBeUndefined();
    expect(header(calls[1], CSRF_HEADER)).toBe("t");
  });
});

describe("errors", () => {
  it("maps the envelope onto ApiError", async () => {
    transport(
      json(200, { csrf_token: "t" }),
      json(400, envelope("http_error", "That code doesn't match tonight's night.", "req-42")),
    );

    const error = await api.join({ slug: "baez", night_code: "ZZZZZZ" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "http_error",
      message: "That code doesn't match tonight's night.",
      requestId: "req-42",
      retryAfter: null,
    });
  });

  it("reads Retry-After on a 429", async () => {
    transport(
      json(200, { csrf_token: "t" }),
      json(429, envelope("http_error", "Too many attempts."), { "Retry-After": "120" }),
    );

    const error = (await api.join({ slug: "s", night_code: "ABC234" }).catch((e) => e)) as ApiError;

    expect(error.retryAfter).toBe(120);
    expect(retryAfterHint(error)).toBe("Try again in 2 minutes.");
  });

  it("falls back to a generic message when the body is not the envelope", async () => {
    const error = await toApiError(new Response("<html>Bad gateway</html>", { status: 502 }));

    expect(error).toMatchObject({ status: 502, code: "unknown_error", requestId: null });
    expect(error.message).toMatch(/Can't reach Family Night/);
  });

  it("turns a transport failure into a network_error", async () => {
    transport(new TypeError("Failed to fetch"));

    await expect(api.people()).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("parses an HTTP-date Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T20:00:00Z"));
    try {
      const error = await toApiError(
        json(429, envelope("http_error", "Slow down"), {
          "Retry-After": "Thu, 15 Oct 2026 20:00:30 GMT",
        }),
      );
      expect(error.retryAfter).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retryAfterHint", () => {
  const tooMany = (seconds: number | null) =>
    new ApiError(429, "http_error", "Too many", null, seconds);

  it.each([
    [1, "Try again in 1 second."],
    [45, "Try again in 45 seconds."],
    [60, "Try again in 1 minute."],
    [61, "Try again in 2 minutes."],
  ])("%i s -> %j", (seconds, hint) => {
    expect(retryAfterHint(tooMany(seconds))).toBe(hint);
  });

  it("is null without Retry-After or for other statuses", () => {
    expect(retryAfterHint(tooMany(null))).toBeNull();
    expect(retryAfterHint(new ApiError(400, "http_error", "Bad", null, 30))).toBeNull();
  });
});

describe("TV screens run on the device only (ADR-0002 amendment 2026-10-18)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const at = (pathname: string) => vi.stubGlobal("window", { location: { pathname } });

  it("sends the device-only header from /tv and /tv/[session]", async () => {
    for (const path of ["/tv", "/tv/n1"]) {
      at(path);
      const calls = transport(json(200, []));
      await api.nights({ status: ["voting"], limit: 1 });
      expect(header(calls[0], DEVICE_ONLY_HEADER)).toBe("1");
    }
  });

  it("leaves it off the portal, phones and look-alike paths", async () => {
    for (const path of ["/host", "/host/n1", "/s/n1", "/tvguide"]) {
      at(path);
      const calls = transport(json(200, []));
      await api.nights({ status: ["voting"], limit: 1 });
      expect(header(calls[0], DEVICE_ONLY_HEADER)).toBeUndefined();
    }
  });
});

describe("enrollDevice", () => {
  const unauthorized = () => json(401, envelope("unauthorized", "Not signed in"));

  it("waits until the new device cookie works (the enroll commit can land after the response)", async () => {
    const calls = transport(
      json(200, { csrf_token: "tok-1" }),
      json(200, { device_id: "d", is_tv: true }),
      unauthorized(),
      unauthorized(),
      json(200, { id: "d", people: [] }),
    );

    await expect(
      enrollDevice({ as_tv: true, keep_session: false }, { delayMs: 0 }),
    ).resolves.toEqual({
      device_id: "d",
      is_tv: true,
    });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET /api/v1/csrf",
      "POST /api/v1/devices/enroll",
      "GET /api/v1/devices/me",
      "GET /api/v1/devices/me",
      "GET /api/v1/devices/me",
    ]);
  });

  it("gives up after the last attempt with the server's error", async () => {
    transport(
      json(200, { csrf_token: "tok-1" }),
      json(200, { device_id: "d", is_tv: false }),
      unauthorized(),
      unauthorized(),
    );
    await expect(
      enrollDevice({ as_tv: false, keep_session: false }, { attempts: 2, delayMs: 0 }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("does not retry anything but a 401", async () => {
    transport(
      json(200, { csrf_token: "tok-1" }),
      json(200, { device_id: "d", is_tv: false }),
      json(500, envelope("internal_error", "Something went wrong")),
    );
    await expect(
      enrollDevice({ as_tv: false, keep_session: false }, { delayMs: 0 }),
    ).rejects.toMatchObject({
      status: 500,
    });
  });
});
