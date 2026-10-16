/**
 * Photo processing on the phone, one file at a time (ADR-0005, 04-frontend.md "Photo drop").
 *
 * 1. Read `DateTimeOriginal` with exifr: the date only. Nothing else leaves the original.
 * 2. Decode with `createImageBitmap` (orientation applied). Chrome and Firefox can't decode HEIC,
 *    so on failure lazy-load `heic-to/next`, whose libheif WASM runs in its own Web Worker.
 * 3. Draw onto a canvas and encode a fresh JPEG: at most 2048px on the long edge at q 0.82, plus a
 *    480px thumbnail. A canvas JPEG carries no EXIF at all, so GPS (and everything else the
 *    camera wrote) is dropped. The unit test asserts that with exifr.
 *
 * The decode/encode pair is a `Codec` so the unit test can run the same pipeline with a real JPEG
 * encoder in Node (@napi-rs/canvas). The browser codec is the default.
 */
import exifr from "exifr";

export const FULL_EDGE = 2048;
export const THUMB_EDGE = 480;
export const JPEG_QUALITY = 0.82;
export const JPEG = "image/jpeg";

export type Raster = { width: number; height: number };

export interface Codec<R extends Raster = Raster> {
  decode(file: Blob): Promise<R>;
  /** A JPEG of `image` scaled to width x height. Must not copy any metadata across. */
  encode(image: R, width: number, height: number, quality: number): Promise<Blob>;
  release?(image: R): void;
}

export type ProcessedPhoto = {
  full: Blob;
  thumb: Blob;
  /** YYYY-MM-DD from EXIF DateTimeOriginal, or null. */
  takenOn: string | null;
};

export class UnreadablePhotoError extends Error {
  constructor() {
    super("This photo couldn't be read. Try another one.");
    this.name = "UnreadablePhotoError";
  }
}

/** Scale (width, height) so the long edge is at most `edge`. Never upscales. */
export function fit(width: number, height: number, edge: number): [number, number] {
  const scale = Math.min(1, edge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** "2026:10:10 19:30:00" → "2026-10-10". Anything malformed is null. */
export function exifDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31 || y === "0000") return null;
  return `${y}-${m}-${d}`;
}

/** The capture date only. A file without EXIF (or one exifr can't parse) has no date. */
export async function readTakenOn(file: Blob): Promise<string | null> {
  try {
    // reviveValues: false keeps the raw string, so no timezone guess turns 23:30 into tomorrow.
    // An ArrayBuffer rather than the Blob: exifr reads Blobs through FileReader, which Node lacks.
    const tags = (await exifr.parse(await file.arrayBuffer(), {
      pick: ["DateTimeOriginal"],
      reviveValues: false,
    })) as { DateTimeOriginal?: unknown } | undefined;
    return exifDate(tags?.DateTimeOriginal);
  } catch {
    return null;
  }
}

export async function processPhoto<R extends Raster>(
  file: Blob,
  codec: Codec<R>,
): Promise<ProcessedPhoto> {
  const takenOn = await readTakenOn(file);
  let image: R;
  try {
    image = await codec.decode(file);
  } catch {
    throw new UnreadablePhotoError();
  }
  try {
    const [fw, fh] = fit(image.width, image.height, FULL_EDGE);
    const [tw, th] = fit(image.width, image.height, THUMB_EDGE);
    const full = await codec.encode(image, fw, fh, JPEG_QUALITY);
    const thumb = await codec.encode(image, tw, th, JPEG_QUALITY);
    return { full, thumb, takenOn };
  } finally {
    codec.release?.(image);
  }
}

/** The phone's codec: createImageBitmap, falling back to the heic-to worker, then a canvas. */
export const browserCodec: Codec<ImageBitmap> = {
  async decode(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // HEIC on Chrome/Firefox. Loaded only now: the decoder is a ~3 MB chunk.
      const { heicTo } = await import("heic-to/next");
      return heicTo({ blob: file, type: "bitmap", options: { imageOrientation: "from-image" } });
    }
  },
  async encode(image, width, height, quality) {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      draw(canvas.getContext("2d"), image, width, height);
      return canvas.convertToBlob({ type: JPEG, quality });
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext("2d"), image, width, height);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new UnreadablePhotoError())),
        JPEG,
        quality,
      ),
    );
  },
  release(image) {
    image.close();
  },
};

function draw(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null,
  image: ImageBitmap,
  width: number,
  height: number,
) {
  if (!context) throw new UnreadablePhotoError();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
}
