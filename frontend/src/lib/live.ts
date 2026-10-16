/**
 * The live-stream half of `useLiveSession` (ADR-0004, 04-frontend.md "State management"), kept
 * free of React so its state machine is unit-tested with a fake EventSource and fake timers.
 *
 *   reconnecting ──mint ticket, open EventSource──▶ (onopen) ready
 *        ▲                                              │
 *        └──── close, wait backoff, re-ticket ◀── onerror (drop, 30-min close, 401, degraded)
 *
 * Tickets are single-use with a 60s TTL, so every attempt mints a fresh one and the browser's
 * own EventSource auto-retry (which would replay a spent ticket) is never relied on. Events are
 * hints only: every message, and every (re)open, just tells the caller to refetch the snapshot.
 * A message is never parsed, so nothing on the stream can become screen state.
 */

export type LiveState = "ready" | "reconnecting";

/** Snapshot poll interval while the stream is down. */
export const POLL_MS = 5_000;

/** TanStack `refetchInterval` for anything kept fresh by the stream: poll only while it's down. */
export function pollWhileDown(state: LiveState): number | false {
  return state === "ready" ? false : POLL_MS;
}

/**
 * The night snapshot's `refetchInterval`. `revealed -> tonight` settles lazily on the server
 * (REVEAL_SETTLE, 30s) and publishes nothing (03-backend.md), so a screen left on the reveal with
 * the stream up would never learn the night is `tonight` (no photo drop until a reload). While
 * the night is `revealed` it polls; otherwise only while the stream is down.
 */
export function nightPollInterval(state: LiveState, status: string | undefined): number | false {
  return status === "revealed" ? POLL_MS : pollWhileDown(state);
}

/**
 * `/who`'s people `refetchInterval`. A host approving a pending claim publishes nothing to the
 * phone (/who has no night stream), so while any tile is `pending` the list polls on the
 * snapshot cadence and the tile flips to `mine` without a reload. Otherwise it doesn't poll.
 */
export function pendingPollInterval(
  people: readonly { binding: string }[] | undefined,
): number | false {
  return people?.some((p) => p.binding === "pending") ? POLL_MS : false;
}

/** The slice of `EventSource` the connection uses (so tests can hand it a fake). */
export type StreamLike = {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
};

export type LiveDeps = {
  /** POST /sse-tickets; rejects when the ticket can't be minted. */
  mintTicket: () => Promise<string>;
  /** Opens GET /sessions/{id}/stream?ticket=. */
  openStream: (ticket: string) => StreamLike;
  /** Something changed (or may have while we were away): refetch the snapshot. */
  onHint: () => void;
  onState: (state: LiveState) => void;
};

/**
 * Wait before re-ticket attempt n (the last entry repeats). The first retry is quick because the
 * commonest drop is the server's planned 30-minute close; polling covers every gap meanwhile.
 */
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export class LiveConnection {
  private readonly deps: LiveDeps;
  private state: LiveState = "reconnecting";
  private source: StreamLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private failures = 0;
  private running = false;
  /** Bumped by every attempt and by stop(), so a late ticket from an old attempt is dropped. */
  private attempt = 0;

  constructor(deps: LiveDeps) {
    this.deps = deps;
  }

  get current(): LiveState {
    return this.state;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop() {
    this.running = false;
    this.attempt++;
    this.clearRetry();
    this.closeSource();
    this.connecting = false;
    this.state = "reconnecting";
  }

  /**
   * The tab came back or the network did: if the stream is down and waiting out a backoff,
   * re-ticket now instead. An open or opening stream is left alone, but the backoff restarts, so
   * if that attempt fails the next one is quick.
   */
  wake() {
    if (!this.running) return;
    this.failures = 0;
    if (this.connecting || this.source) return;
    this.clearRetry();
    void this.connect();
  }

  private async connect() {
    const attempt = ++this.attempt;
    this.connecting = true;
    let ticket: string;
    try {
      ticket = await this.deps.mintTicket();
    } catch {
      if (attempt !== this.attempt) return;
      this.connecting = false;
      this.scheduleRetry();
      return;
    }
    if (attempt !== this.attempt) return;

    const source = this.deps.openStream(ticket);
    this.source = source;
    // closeSource() detaches these handlers, so a dead stream can never call back in.
    source.onopen = () => {
      this.connecting = false;
      this.failures = 0;
      this.setState("ready");
      // Anything published before the subscription (or while we were down) was missed.
      this.deps.onHint();
    };
    source.onmessage = () => this.deps.onHint();
    source.onerror = () => {
      this.closeSource();
      this.connecting = false;
      this.setState("reconnecting");
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private clearRetry() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private closeSource() {
    const source = this.source;
    this.source = null;
    if (!source) return;
    source.onopen = source.onmessage = source.onerror = null;
    source.close();
  }

  private setState(state: LiveState) {
    if (state === this.state) return;
    this.state = state;
    this.deps.onState(state);
  }
}
