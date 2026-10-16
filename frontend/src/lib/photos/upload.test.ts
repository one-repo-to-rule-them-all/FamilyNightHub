import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApi } from "@/lib/api";

import { type UploadJob } from "./job-store";
import { UploadError } from "./queue";
import { makeUploader, type Put } from "./upload";

const CREATED = {
  photo_id: "photo-1",
  upload_url: "https://bucket.test/full?sig",
  thumb_upload_url: "https://bucket.test/thumb?sig",
  expires_in: 300,
};

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const refusal = (status: number, message: string) =>
  json(status, { error: { code: "x", message, request_id: "r" } });

type Route = (method: string, path: string, body: unknown) => Response;

function server(route: Route) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  configureApi({
    fetch: async (input, init) => {
      const path = String(input).replace(/^\/api\/v1/, "");
      if (path === "/csrf") return json(200, { csrf_token: "t" });
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      return route(method, path, body);
    },
  });
  return calls;
}

const job = (overrides: Partial<UploadJob> = {}): UploadJob => ({
  id: "j1",
  sessionId: "night-1",
  personId: "ava",
  name: "IMG_1.HEIC",
  takenOn: "2026-10-10",
  full: new Blob([new Uint8Array(300)]),
  thumb: new Blob([new Uint8Array(100)]),
  attempts: 0,
  photoId: null,
  createdAt: 1,
  ...overrides,
});

function hooks() {
  const progress: number[] = [];
  const uploaded: string[] = [];
  return {
    progress,
    uploaded,
    onProgress: (f: number) => progress.push(f),
    onUploaded: async (id: string) => {
      uploaded.push(id);
    },
  };
}

afterEach(() => configureApi());

describe("upload", () => {
  it("creates, PUTs the JPEG then the thumbnail, then completes", async () => {
    const calls = server((method, path) =>
      method === "POST" && path === "/sessions/night-1/photos"
        ? json(201, CREATED)
        : json(204, undefined),
    );
    const puts: string[] = [];
    const put: Put = async (url, body, onProgress) => {
      puts.push(`${url} ${body.size}`);
      onProgress(1);
    };
    const h = hooks();

    await makeUploader(put)(job(), h);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/sessions/night-1/photos",
        body: { person_id: "ava", taken_on: "2026-10-10" },
      },
      { method: "POST", path: "/sessions/night-1/photos/photo-1/complete", body: undefined },
    ]);
    expect(puts).toEqual([`${CREATED.upload_url} 300`, `${CREATED.thumb_upload_url} 100`]);
    expect(h.progress).toEqual([0.75, 1]);
    expect(h.uploaded).toEqual(["photo-1"]);
  });

  it("only completes a job whose PUTs already went through", async () => {
    const calls = server(() => json(204, undefined));
    const put = vi.fn<Put>();
    await makeUploader(put)(job({ photoId: "photo-7" }), hooks());
    expect(put).not.toHaveBeenCalled();
    expect(calls.map((c) => c.path)).toEqual(["/sessions/night-1/photos/photo-7/complete"]);
  });

  it("a refusal is final and keeps the server's message", async () => {
    server(() => refusal(409, "Photos open once tonight's movie is picked"));
    const error = await makeUploader(vi.fn<Put>())(job(), hooks()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({
      retryable: false,
      message: "Photos open once tonight's movie is picked",
    });
  });

  it.each([
    [503, "Photo storage is unavailable; try again shortly"],
    [429, "Slow down"],
  ])("a %i is retried", async (status, message) => {
    server(() => refusal(status, message));
    await expect(makeUploader(vi.fn<Put>())(job(), hooks())).rejects.toMatchObject({
      retryable: true,
      restart: false,
      message,
    });
  });

  it("no network at all is retried", async () => {
    configureApi({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(makeUploader(vi.fn<Put>())(job(), hooks())).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("a failed PUT is retried and nothing is completed", async () => {
    const calls = server(() => json(201, CREATED));
    const put: Put = async () => {
      throw new UploadError("The upload didn't go through. Retrying…", { retryable: true });
    };
    await expect(makeUploader(put)(job(), hooks())).rejects.toMatchObject({ retryable: true });
    expect(calls.map((c) => c.path)).toEqual(["/sessions/night-1/photos"]);
  });

  it("complete saying the upload is missing restarts from create", async () => {
    server((_, path) =>
      path.endsWith("/complete") ? refusal(422, "The photo was not uploaded") : json(201, CREATED),
    );
    await expect(makeUploader(async () => {})(job(), hooks())).rejects.toMatchObject({
      retryable: true,
      restart: true,
    });
  });

  it("complete refusing for another reason is final", async () => {
    server(() => refusal(404, "Photo not found"));
    await expect(
      makeUploader(vi.fn<Put>())(job({ photoId: "gone" }), hooks()),
    ).rejects.toMatchObject({ retryable: false, message: "Photo not found" });
  });
});
