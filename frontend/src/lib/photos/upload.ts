/**
 * One photo's upload: create (presign) → PUT the JPEG → PUT the thumbnail → complete (ADR-0005).
 *
 * The bytes go straight to the private bucket; the API only sees JSON. Both PUTs send
 * `Content-Type: image/jpeg` exactly, because the type is part of the presigned signature, and
 * no cookies (the bucket is another origin). XHR rather than fetch, for upload progress.
 *
 * Errors are sorted for the queue: the network, a 5xx or a 429 is worth retrying; any other API
 * refusal is final and carries the server's message. A PUT failure (including an expired URL)
 * retries from create; `complete` saying the upload is missing retries from create too.
 */
import { api, ApiError } from "@/lib/api";

import { type UploadJob } from "./job-store";
import { JPEG } from "./process";
import { type UploadHooks, UploadError } from "./queue";

export type Put = (
  url: string,
  body: Blob,
  onProgress: (fraction: number) => void,
) => Promise<void>;

const PUT_FAILED = "The upload didn't go through. Retrying…";

/** PUT with progress. Resolves on 2xx; anything else is a retryable UploadError. */
export const xhrPut: Put = (url, body, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", JPEG);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new UploadError(PUT_FAILED, { retryable: true }));
    };
    xhr.onerror = () => reject(new UploadError(PUT_FAILED, { retryable: true }));
    xhr.ontimeout = xhr.onerror;
    xhr.send(body);
  });

function fromApi(error: unknown, restartOn422 = false): UploadError {
  if (!(error instanceof ApiError)) return new UploadError(PUT_FAILED, { retryable: true });
  if (error.status === 0 || error.status >= 500 || error.status === 429) {
    return new UploadError(error.message, { retryable: true });
  }
  if (restartOn422 && error.status === 422) {
    return new UploadError(error.message, { retryable: true, restart: true });
  }
  return new UploadError(error.message, { retryable: false });
}

export function makeUploader(put: Put = xhrPut) {
  return async function upload(job: UploadJob, hooks: UploadHooks): Promise<void> {
    let photoId = job.photoId;
    if (!photoId) {
      let created;
      try {
        created = await api.createPhoto(job.sessionId, {
          person_id: job.personId,
          taken_on: job.takenOn,
        });
      } catch (error) {
        throw fromApi(error);
      }
      // Progress is by bytes across both objects.
      const total = job.full.size + job.thumb.size || 1;
      await put(created.upload_url, job.full, (f) => hooks.onProgress((f * job.full.size) / total));
      await put(created.thumb_upload_url, job.thumb, (f) =>
        hooks.onProgress((job.full.size + f * job.thumb.size) / total),
      );
      photoId = created.photo_id;
      await hooks.onUploaded(photoId);
    }
    try {
      await api.completePhoto(job.sessionId, photoId);
    } catch (error) {
      throw fromApi(error, true);
    }
  };
}
