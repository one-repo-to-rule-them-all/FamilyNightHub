"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { albumKey } from "@/hooks/use-album";
import { indexedDbStore } from "@/lib/photos/job-store";
import { browserCodec, processPhoto, UnreadablePhotoError } from "@/lib/photos/process";
import { type JobStatus, UploadQueue } from "@/lib/photos/queue";
import { makeUploader } from "@/lib/photos/upload";

/** One queue per tab, created on first use in the browser. */
let queue: UploadQueue | null = null;
/** Files are processed one at a time (ADR-0005): each new pick joins the end of this chain. */
let processing: Promise<void> = Promise.resolve();

function getQueue(): UploadQueue {
  queue ??= new UploadQueue({ store: indexedDbStore(), upload: makeUploader() });
  return queue;
}

const EMPTY: JobStatus[] = [];

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The photo drop's state for one night: per-file rows (processing → uploading → done/failed) and
 * `add(files, personId)`. Leftover jobs from an earlier page load resume on mount, and again
 * whenever the tab becomes visible or the phone comes back online.
 */
export function usePhotoUploads(sessionId: string) {
  const queryClient = useQueryClient();
  const all = useSyncExternalStore(
    (listener) => getQueue().subscribe(listener),
    () => getQueue().snapshot(),
    () => EMPTY,
  );
  const rows = useMemo(() => all.filter((s) => s.sessionId === sessionId), [all, sessionId]);

  useEffect(() => {
    const q = getQueue();
    void q.restore();
    const resume = () => {
      if (document.visibilityState === "visible") q.resume();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    const off = q.onComplete((job) => {
      void queryClient.invalidateQueries({ queryKey: albumKey(job.sessionId) });
    });
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      off();
    };
  }, [queryClient]);

  const add = useCallback(
    (files: File[], personId: string) => {
      const q = getQueue();
      for (const file of files) {
        const id = newId();
        q.track(id, sessionId, file.name);
        processing = processing.then(async () => {
          try {
            const photo = await processPhoto(file, browserCodec);
            await q.add({
              id,
              sessionId,
              personId,
              name: file.name,
              takenOn: photo.takenOn,
              full: photo.full,
              thumb: photo.thumb,
              attempts: 0,
              photoId: null,
              createdAt: Date.now(),
            });
          } catch (error) {
            q.processingFailed(
              id,
              error instanceof UnreadablePhotoError ? error.message : "Couldn't add this photo.",
            );
          }
        });
      }
    },
    [sessionId],
  );

  const retry = useCallback((id: string) => void getQueue().retry(id), []);
  const dismiss = useCallback((id: string) => void getQueue().dismiss(id), []);

  return { rows, add, retry, dismiss };
}
