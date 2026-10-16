/**
 * The upload queue (ADR-0005, 04-frontend.md "Photo drop").
 *
 * - Jobs (processed JPEG + thumbnail) are persisted in a `JobStore` (IndexedDB on the phone) before
 *   anything is sent, and deleted once the photo is complete.
 * - At most `maxParallel` (2) jobs run at once. A job PUTs its two objects one after the other, so
 *   no more than two PUTs are ever in flight.
 * - A retryable failure waits `backoff(attempts)` (1s, 2s, 4s ... capped at 30s) and runs again;
 *   after `maxAttempts` the job is `failed` and waits for a tap on Retry. A permanent failure (the
 *   server said no: album closed, not your person) fails at once with the server's message.
 * - `resume()` (called on `visibilitychange` → visible and on `online`) runs every waiting job
 *   now: a locked phone throttles or freezes timers, so a backoff may never fire on its own.
 *
 * Processing is tracked here too (`track` / `processingFailed`), so one list drives the per-file
 * progress rows, but a file is only persisted once processed: an original never reaches the disk.
 */
import { type JobStore, type UploadJob } from "./job-store";

export type JobState = "processing" | "queued" | "uploading" | "waiting" | "done" | "failed";

export type JobStatus = {
  id: string;
  sessionId: string;
  name: string;
  state: JobState;
  /** 0..1 while uploading. */
  progress: number;
  error: string | null;
};

export class UploadError extends Error {
  readonly retryable: boolean;
  /** The bucket lost the upload (complete said so): start again from create. */
  readonly restart: boolean;

  constructor(message: string, options: { retryable: boolean; restart?: boolean }) {
    super(message);
    this.name = "UploadError";
    this.retryable = options.retryable;
    this.restart = options.restart ?? false;
  }
}

export type UploadHooks = {
  onProgress: (fraction: number) => void;
  /** Both PUTs succeeded: the queue persists the photo id so a retry only completes. */
  onUploaded: (photoId: string) => Promise<void>;
};

export type Uploader = (job: UploadJob, hooks: UploadHooks) => Promise<void>;

export const MAX_PARALLEL = 2;
export const MAX_ATTEMPTS = 6;
const GENERIC_ERROR = "Couldn't upload this photo.";

/** 1s, 2s, 4s, 8s, 16s, then 30s. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

type Options = {
  store: JobStore;
  upload: Uploader;
  maxParallel?: number;
  maxAttempts?: number;
  backoff?: (attempts: number) => number;
};

export class UploadQueue {
  private readonly store: JobStore;
  private readonly upload: Uploader;
  private readonly maxParallel: number;
  private readonly maxAttempts: number;
  private readonly backoff: (attempts: number) => number;

  private readonly jobs = new Map<string, UploadJob>();
  private statuses = new Map<string, JobStatus>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ready: string[] = [];
  private active = 0;
  private restored: Promise<void> | null = null;
  private snapshotCache: JobStatus[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly completeListeners = new Set<(job: UploadJob) => void>();

  constructor(options: Options) {
    this.store = options.store;
    this.upload = options.upload;
    this.maxParallel = options.maxParallel ?? MAX_PARALLEL;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.backoff = options.backoff ?? backoffMs;
  }

  /** For useSyncExternalStore: a stable array until something changes. */
  snapshot = (): JobStatus[] => this.snapshotCache;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called after each photo is complete (e.g. to refetch the album). */
  onComplete(listener: (job: UploadJob) => void): () => void {
    this.completeListeners.add(listener);
    return () => this.completeListeners.delete(listener);
  }

  /** Load jobs left over from an earlier page load and run them. Idempotent. */
  restore(): Promise<void> {
    this.restored ??= this.store.all().then((jobs) => {
      for (const job of jobs) {
        if (this.jobs.has(job.id)) continue;
        this.jobs.set(job.id, job);
        this.setStatus(job, { state: "queued" });
        this.ready.push(job.id);
      }
      this.pump();
    });
    return this.restored;
  }

  /** A file is being processed (not persisted yet). */
  track(id: string, sessionId: string, name: string): void {
    this.statuses.set(id, { id, sessionId, name, state: "processing", progress: 0, error: null });
    this.emit();
  }

  processingFailed(id: string, message: string): void {
    this.patch(id, { state: "failed", error: message });
  }

  /** Persist a processed photo, then upload it. */
  async add(job: UploadJob): Promise<void> {
    await this.store.put(job);
    this.jobs.set(job.id, job);
    this.setStatus(job, { state: "queued" });
    this.ready.push(job.id);
    this.pump();
  }

  /** Run every job that is waiting out a backoff now. */
  resume(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(id);
      this.ready.push(id);
      this.patch(id, { state: "queued" });
    }
    this.pump();
  }

  /** Tap on Retry: a failed job starts over with a fresh attempt budget. */
  async retry(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || this.statuses.get(id)?.state !== "failed") return;
    const fresh = { ...job, attempts: 0 };
    await this.store.put(fresh);
    this.jobs.set(id, fresh);
    this.patch(id, { state: "queued", error: null, progress: 0 });
    this.ready.push(id);
    this.pump();
  }

  /** Forget a finished or failed row (and the stored job, if any). */
  async dismiss(id: string): Promise<void> {
    const state = this.statuses.get(id)?.state;
    if (state !== "done" && state !== "failed") return;
    this.jobs.delete(id);
    await this.store.delete(id);
    this.statuses.delete(id);
    this.emit();
  }

  private pump(): void {
    while (this.active < this.maxParallel && this.ready.length > 0) {
      const id = this.ready.shift() as string;
      const job = this.jobs.get(id);
      if (!job) continue;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(job: UploadJob): Promise<void> {
    let current = job;
    this.patch(job.id, { state: "uploading", progress: 0, error: null });
    try {
      await this.upload(current, {
        onProgress: (fraction) =>
          this.patch(job.id, { progress: Math.max(0, Math.min(1, fraction)) }),
        onUploaded: async (photoId) => {
          current = { ...current, photoId };
          this.jobs.set(job.id, current);
          await this.store.put(current);
        },
      });
    } catch (error) {
      await this.failed(current, error);
      return;
    }
    this.jobs.delete(job.id);
    await this.store.delete(job.id);
    this.patch(job.id, { state: "done", progress: 1 });
    for (const listener of this.completeListeners) listener(current);
  }

  private async failed(job: UploadJob, error: unknown): Promise<void> {
    const upload = error instanceof UploadError ? error : null;
    const message = upload?.message ?? GENERIC_ERROR;
    const next: UploadJob = {
      ...job,
      attempts: job.attempts + 1,
      photoId: upload?.restart ? null : job.photoId,
    };
    this.jobs.set(job.id, next);
    await this.store.put(next);

    const retryable = upload ? upload.retryable : true;
    if (!retryable || next.attempts >= this.maxAttempts) {
      this.patch(job.id, { state: "failed", error: message });
      return;
    }
    this.patch(job.id, { state: "waiting", error: null });
    this.timers.set(
      job.id,
      setTimeout(() => {
        this.timers.delete(job.id);
        this.ready.push(job.id);
        this.patch(job.id, { state: "queued" });
        this.pump();
      }, this.backoff(next.attempts)),
    );
  }

  private setStatus(job: UploadJob, patch: Partial<JobStatus>): void {
    this.statuses.set(job.id, {
      id: job.id,
      sessionId: job.sessionId,
      name: job.name,
      state: "queued",
      progress: 0,
      error: null,
      ...patch,
    });
    this.emit();
  }

  private patch(id: string, patch: Partial<JobStatus>): void {
    const status = this.statuses.get(id);
    if (!status) return;
    this.statuses.set(id, { ...status, ...patch });
    this.emit();
  }

  private emit(): void {
    this.snapshotCache = [...this.statuses.values()];
    for (const listener of this.listeners) listener();
  }
}
