/**
 * Where queued uploads wait: IndexedDB, so a phone that locks, reloads or drops off Wi-Fi mid-way
 * picks up where it left off (ADR-0005). Only processed JPEGs are stored, never an original, so
 * nothing with GPS ever touches the disk. A job is deleted as soon as its photo is complete.
 */

export type UploadJob = {
  /** Client-side id (not the photo id). */
  id: string;
  sessionId: string;
  personId: string;
  /** The original file name, for the progress row. */
  name: string;
  takenOn: string | null;
  full: Blob;
  thumb: Blob;
  /** Failed attempts so far. */
  attempts: number;
  /** Set once both PUTs succeeded: a retry then only needs `complete`. */
  photoId: string | null;
  createdAt: number;
};

export interface JobStore {
  all(): Promise<UploadJob[]>;
  put(job: UploadJob): Promise<void>;
  delete(id: string): Promise<void>;
}

export function memoryStore(): JobStore {
  const jobs = new Map<string, UploadJob>();
  return {
    all: async () => [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt),
    put: async (job) => {
      jobs.set(job.id, job);
    },
    delete: async (id) => {
      jobs.delete(id);
    },
  };
}

const DB_NAME = "fnh-uploads";
const STORE = "jobs";

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STORE, { keyPath: "id" });
  };
  return promised(request);
}

/**
 * IndexedDB-backed store. If IndexedDB is missing or refuses to open (some private modes), the
 * queue still works for this page load from memory.
 */
export function indexedDbStore(factory: IDBFactory | undefined = globalThis.indexedDB): JobStore {
  const db: Promise<IDBDatabase | null> = factory
    ? open(factory).catch(() => null)
    : Promise.resolve(null);
  const fallback = memoryStore();

  return {
    async all() {
      const handle = await db;
      if (!handle) return fallback.all();
      const tx = handle.transaction(STORE, "readonly");
      const jobs = await promised(tx.objectStore(STORE).getAll() as IDBRequest<UploadJob[]>);
      return jobs.sort((a, b) => a.createdAt - b.createdAt);
    },
    async put(job) {
      const handle = await db;
      if (!handle) return fallback.put(job);
      const tx = handle.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(job);
      await done(tx);
    },
    async delete(id) {
      const handle = await db;
      if (!handle) return fallback.delete(id);
      const tx = handle.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      await done(tx);
    },
  };
}
