import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { indexedDbStore, memoryStore, type UploadJob } from "./job-store";

const job = (id: string, createdAt: number): UploadJob => ({
  id,
  sessionId: "night-1",
  personId: "ava",
  name: `${id}.jpg`,
  takenOn: "2026-10-10",
  full: new Blob(["full-bytes"], { type: "image/jpeg" }),
  thumb: new Blob(["t"], { type: "image/jpeg" }),
  attempts: 0,
  photoId: null,
  createdAt,
});

describe.each([
  ["IndexedDB", () => indexedDbStore(new IDBFactory())],
  ["memory", () => memoryStore()],
  ["IndexedDB unavailable", () => indexedDbStore(undefined)],
])("%s store", (_, make) => {
  it("keeps jobs (with their blobs) oldest first, replaces by id, deletes", async () => {
    const store = make();
    await store.put(job("b", 2));
    await store.put(job("a", 1));
    await store.put({ ...job("b", 2), attempts: 3 });

    const all = await store.all();
    expect(all.map((j) => [j.id, j.attempts])).toEqual([
      ["a", 0],
      ["b", 3],
    ]);
    expect(await all[0].full.text()).toBe("full-bytes");

    await store.delete("a");
    await store.delete("missing");
    expect((await store.all()).map((j) => j.id)).toEqual(["b"]);
  });
});

it("survives a page reload: a new store on the same database sees the jobs", async () => {
  const factory = new IDBFactory();
  await indexedDbStore(factory).put(job("left-behind", 1));
  expect((await indexedDbStore(factory).all()).map((j) => j.id)).toEqual(["left-behind"]);
});

it("falls back to memory when IndexedDB refuses to open", async () => {
  const broken = {
    open: () => {
      const request = {} as IDBOpenDBRequest & { error: Error };
      queueMicrotask(() => request.onerror?.(new Event("error")));
      return request;
    },
  } as unknown as IDBFactory;
  const store = indexedDbStore(broken);
  await store.put(job("x", 1));
  expect((await store.all()).map((j) => j.id)).toEqual(["x"]);
});
