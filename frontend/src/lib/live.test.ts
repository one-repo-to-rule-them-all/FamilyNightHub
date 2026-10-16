import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKOFF_MS,
  LiveConnection,
  type LiveState,
  POLL_MS,
  nightPollInterval,
  pendingPollInterval,
  pollWhileDown,
  type StreamLike,
} from "./live";

class FakeStream implements StreamLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly ticket: string) {}
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event("open"));
  }
  message(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
}

/** A connection over fakes: tickets are t1, t2, ...; minting can be made to fail. */
function harness() {
  const streams: FakeStream[] = [];
  const states: LiveState[] = [];
  let minted = 0;
  const mint = { fail: false };
  const onHint = vi.fn();
  const connection = new LiveConnection({
    mintTicket: () => {
      minted++;
      return mint.fail ? Promise.reject(new Error("401")) : Promise.resolve(`t${minted}`);
    },
    openStream: (ticket) => {
      const stream = new FakeStream(ticket);
      streams.push(stream);
      return stream;
    },
    onHint,
    onState: (state) => states.push(state),
  });
  return {
    connection,
    streams,
    states,
    onHint,
    mint,
    minted: () => minted,
    last: () => streams.at(-1)!,
  };
}

/** Lets the awaited ticket promise settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("pollWhileDown", () => {
  it("polls the snapshot only while the stream is down", () => {
    expect(pollWhileDown("reconnecting")).toBe(POLL_MS);
    expect(pollWhileDown("ready")).toBe(false);
  });
});

describe("nightPollInterval", () => {
  it("polls a revealed night even with the stream up: its settle into tonight sends no event", () => {
    expect(nightPollInterval("ready", "revealed")).toBe(POLL_MS);
    expect(nightPollInterval("reconnecting", "revealed")).toBe(POLL_MS);
  });

  it("otherwise polls only while the stream is down", () => {
    for (const status of ["draft", "voting", "tonight", "closed", undefined]) {
      expect(nightPollInterval("ready", status)).toBe(false);
      expect(nightPollInterval("reconnecting", status)).toBe(POLL_MS);
    }
  });
});

describe("pendingPollInterval", () => {
  it("polls while any person is pending, so an approval shows without a reload", () => {
    expect(pendingPollInterval([{ binding: "mine" }, { binding: "pending" }])).toBe(POLL_MS);
  });

  it("stops once nothing is pending, and before the list has loaded", () => {
    expect(pendingPollInterval([{ binding: "mine" }, { binding: "free" }])).toBe(false);
    expect(pendingPollInterval([])).toBe(false);
    expect(pendingPollInterval(undefined)).toBe(false);
  });
});

describe("LiveConnection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("mints a ticket, opens the stream, and is ready (with a catch-up hint) on open", async () => {
    const h = harness();
    h.connection.start();
    expect(h.connection.current).toBe("reconnecting");
    await settle();
    expect(h.streams.map((s) => s.ticket)).toEqual(["t1"]);
    expect(h.onHint).not.toHaveBeenCalled();

    h.last().open();
    expect(h.connection.current).toBe("ready");
    expect(h.states).toEqual(["ready"]);
    expect(h.onHint).toHaveBeenCalledTimes(1);
  });

  it("turns every message into a hint without reading it", async () => {
    const h = harness();
    h.connection.start();
    await settle();
    h.last().open();
    h.last().message('{"type":"ballot_count","version":3}');
    h.last().message("not even json");
    expect(h.onHint).toHaveBeenCalledTimes(3);
  });

  it("re-tickets after a drop (a ticket is single-use) and backs off while it keeps failing", async () => {
    const h = harness();
    h.connection.start();
    await settle();
    h.last().open();

    // The server's 30-minute close (or a dropped phone connection) surfaces as an error.
    h.last().fail();
    expect(h.streams[0]!.closed).toBe(true);
    expect(h.connection.current).toBe("reconnecting");
    expect(h.states).toEqual(["ready", "reconnecting"]);

    // Fresh ticket after the first backoff step, never the spent one.
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0] - 1);
    expect(h.streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.streams.map((s) => s.ticket)).toEqual(["t1", "t2"]);

    // Failing again (the stream 401s before opening) waits longer each time, capped.
    h.last().fail();
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[1]);
    expect(h.streams).toHaveLength(3);
    h.mint.fail = true;
    h.last().fail();
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[2]); // mint fails
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[3]); // mint fails
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[4]); // mint fails
    expect(h.minted()).toBe(6);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[4] - 1);
    expect(h.minted()).toBe(6);
    h.mint.fail = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(h.minted()).toBe(7);
    expect(h.streams).toHaveLength(4);

    // A good open resets the backoff and hints, so the missed changes are refetched.
    h.onHint.mockClear();
    h.last().open();
    expect(h.connection.current).toBe("ready");
    expect(h.onHint).toHaveBeenCalledTimes(1);
    h.last().fail();
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
    expect(h.streams).toHaveLength(5);
  });

  it("wake() skips the backoff while down and leaves a live stream alone", async () => {
    const h = harness();
    h.connection.start();
    await settle();
    // Fail a few times so the backoff grows.
    for (const delay of BACKOFF_MS.slice(0, 3)) {
      h.last().fail();
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(h.streams).toHaveLength(4);
    h.connection.wake(); // still opening: left alone, but the backoff restarts
    expect(h.minted()).toBe(4);
    h.last().fail();
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
    expect(h.streams).toHaveLength(5);
    h.last().open();
    h.connection.wake(); // up
    expect(h.minted()).toBe(5);

    h.last().fail();
    h.last().fail(); // a stale stream's late error is ignored
    h.connection.wake();
    await settle();
    expect(h.streams).toHaveLength(6);
    // The pending backoff timer was cancelled, so it doesn't open another stream.
    await vi.advanceTimersByTimeAsync(BACKOFF_MS.at(-1)!);
    expect(h.streams).toHaveLength(6);
  });

  it("stop() closes the stream, cancels retries, and drops a ticket that arrives late", async () => {
    const h = harness();
    h.connection.start();
    h.connection.start(); // idempotent
    h.connection.stop(); // before the ticket resolves
    await settle();
    expect(h.streams).toHaveLength(0);

    h.connection.start();
    await settle();
    h.last().open();
    h.connection.stop();
    expect(h.last().closed).toBe(true);
    expect(h.connection.current).toBe("reconnecting");
    h.connection.wake(); // stopped: no-op
    await vi.advanceTimersByTimeAsync(BACKOFF_MS.at(-1)!);
    expect(h.streams).toHaveLength(1);

    // A failed mint racing stop() doesn't schedule a retry either.
    h.mint.fail = true;
    h.connection.start();
    h.connection.stop();
    await vi.advanceTimersByTimeAsync(BACKOFF_MS.at(-1)!);
    expect(h.minted()).toBe(3);
  });
});
