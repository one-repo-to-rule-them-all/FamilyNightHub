import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type JobStore, memoryStore, type UploadJob } from "./job-store";
import { backoffMs, type UploadHooks, UploadError, UploadQueue } from "./queue";

type Call = {
  job: UploadJob;
  hooks: UploadHooks;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** An uploader whose calls stay pending until the test settles them. */
function controlledUploader() {
  const calls: Call[] = [];
  const upload = (job: UploadJob, hooks: UploadHooks) =>
    new Promise<void>((resolve, reject) => calls.push({ job, hooks, resolve, reject }));
  return { calls, upload };
}

let seq = 0;
function job(overrides: Partial<UploadJob> = {}): UploadJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    sessionId: "night-1",
    personId: "ava",
    name: `IMG_${seq}.HEIC`,
    takenOn: null,
    full: new Blob(["full"]),
    thumb: new Blob(["t"]),
    attempts: 0,
    photoId: null,
    createdAt: seq,
    ...overrides,
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(options: { store?: JobStore; maxAttempts?: number } = {}) {
  const store = options.store ?? memoryStore();
  const uploader = controlledUploader();
  const queue = new UploadQueue({
    store,
    upload: uploader.upload,
    maxAttempts: options.maxAttempts,
  });
  const state = (id: string) => queue.snapshot().find((s) => s.id === id);
  return { store, queue, state, ...uploader };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("backoffMs", () => {
  it("doubles from 1s and caps at 30s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(backoffMs(0)).toBe(1_000);
  });
});

describe("UploadQueue", () => {
  it("runs at most two uploads at once, in order", async () => {
    const { queue, calls, state } = setup();
    const jobs = [job(), job(), job()];
    for (const j of jobs) await queue.add(j);

    expect(calls.map((c) => c.job.id)).toEqual([jobs[0].id, jobs[1].id]);
    expect(state(jobs[2].id)?.state).toBe("queued");

    calls[1].resolve();
    await flush();
    expect(calls.map((c) => c.job.id)).toEqual([jobs[0].id, jobs[1].id, jobs[2].id]);
    expect(state(jobs[1].id)?.state).toBe("done");
  });

  it("reports progress, then done; the stored job is gone and listeners hear of it", async () => {
    const { queue, calls, state, store } = setup();
    const completed: string[] = [];
    queue.onComplete((j) => completed.push(j.id));
    const j = job();
    await queue.add(j);
    expect(await store.all()).toHaveLength(1);

    calls[0].hooks.onProgress(0.5);
    expect(state(j.id)).toMatchObject({ state: "uploading", progress: 0.5 });
    calls[0].hooks.onProgress(7);
    expect(state(j.id)?.progress).toBe(1);

    calls[0].resolve();
    await flush();
    expect(state(j.id)).toMatchObject({ state: "done", progress: 1, error: null });
    expect(await store.all()).toEqual([]);
    expect(completed).toEqual([j.id]);
  });

  it("retries a retryable failure after 1s, 2s, 4s ... then fails after maxAttempts", async () => {
    const { queue, calls, state, store } = setup({ maxAttempts: 3 });
    const j = job();
    await queue.add(j);

    calls[0].reject(new UploadError("offline", { retryable: true }));
    await flush();
    expect(state(j.id)?.state).toBe("waiting");
    expect((await store.all())[0].attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].job.attempts).toBe(1);

    calls[1].reject(new Error("socket hang up"));
    await flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);

    calls[2].reject(new UploadError("still offline", { retryable: true }));
    await flush();
    expect(state(j.id)).toMatchObject({ state: "failed", error: "still offline" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
  });

  it("fails a refused upload at once with the server's message", async () => {
    const { queue, calls, state } = setup();
    const j = job();
    await queue.add(j);
    calls[0].reject(
      new UploadError("Photos open once tonight's movie is picked", { retryable: false }),
    );
    await flush();
    expect(state(j.id)).toMatchObject({
      state: "failed",
      error: "Photos open once tonight's movie is picked",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
  });

  it("keeps the photo id after the PUTs, and drops it when the bucket lost the upload", async () => {
    const { queue, calls, store } = setup();
    const j = job();
    await queue.add(j);

    await calls[0].hooks.onUploaded("photo-1");
    expect((await store.all())[0].photoId).toBe("photo-1");
    calls[0].reject(new UploadError("busy", { retryable: true }));
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls[1].job.photoId).toBe("photo-1");

    calls[1].reject(
      new UploadError("The photo was not uploaded", { retryable: true, restart: true }),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls[2].job.photoId).toBeNull();
  });

  it("resume() runs waiting jobs now instead of after their backoff", async () => {
    const { queue, calls, state } = setup();
    const j = job();
    await queue.add(j);
    calls[0].reject(new UploadError("offline", { retryable: true }));
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(state(j.id)?.state).toBe("waiting");

    queue.resume();
    expect(calls).toHaveLength(2);
    expect(state(j.id)?.state).toBe("uploading");
    // The cancelled backoff timer never fires a second run.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
  });

  it("Retry gives a failed job a fresh budget; Clear forgets it", async () => {
    const { queue, calls, state, store } = setup({ maxAttempts: 1 });
    const j = job();
    await queue.add(j);
    calls[0].reject(new UploadError("offline", { retryable: true }));
    await flush();
    expect(state(j.id)?.state).toBe("failed");

    await queue.retry("unknown");
    await queue.retry(j.id);
    expect(calls).toHaveLength(2);
    expect(calls[1].job.attempts).toBe(0);
    expect(state(j.id)).toMatchObject({ state: "uploading", error: null });

    // Only finished rows can be cleared.
    await queue.dismiss(j.id);
    expect(state(j.id)).toBeDefined();
    await queue.retry(j.id);
    expect(calls).toHaveLength(2);

    calls[1].reject(new UploadError("offline", { retryable: true }));
    await flush();
    await queue.dismiss(j.id);
    expect(state(j.id)).toBeUndefined();
    expect(await store.all()).toEqual([]);
  });

  it("restore() picks up jobs a previous page load left behind, once", async () => {
    const store = memoryStore();
    const left = job({ attempts: 2, photoId: "photo-9" });
    await store.put(left);
    const { queue, calls, state } = setup({ store });

    await queue.restore();
    await queue.restore();
    expect(calls).toHaveLength(1);
    expect(calls[0].job).toMatchObject({ id: left.id, photoId: "photo-9", attempts: 2 });
    expect(state(left.id)?.state).toBe("uploading");
  });

  it("tracks processing in the same list, and a file that can't be read fails there", () => {
    const { queue, state } = setup();
    const seen: number[] = [];
    const off = queue.subscribe(() => seen.push(queue.snapshot().length));
    queue.track("p1", "night-1", "IMG_1.HEIC");
    expect(state("p1")).toMatchObject({ state: "processing", name: "IMG_1.HEIC" });
    const before = queue.snapshot();
    expect(queue.snapshot()).toBe(before);

    queue.processingFailed("p1", "This photo couldn't be read. Try another one.");
    expect(state("p1")).toMatchObject({ state: "failed" });
    queue.processingFailed("nobody", "ignored");
    off();
    queue.track("p2", "night-1", "IMG_2.HEIC");
    expect(seen).toEqual([1, 1]);
  });
});
