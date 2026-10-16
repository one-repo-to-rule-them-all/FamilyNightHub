/**
 * ADR-0005: GPS stripping is a tested property. The GPS-tagged fixtures (e2e/fixtures, made by
 * make_fixtures.py) go through the real pipeline, with a real JPEG encoder standing in for the
 * phone's canvas (@napi-rs/canvas, Skia), and exifr then looks for any trace of the GPS IFD.
 *
 * HEIC: Node has no HEIC decoder, so here it only proves the date is read and that an
 * undecodable file is refused cleanly. The HEIC decode itself (heic-to worker) is exercised by
 * the Playwright upload in Chromium, and on a real iPhone by the manual release checklist
 * (docs/runbooks/photo-drop-iphone-checklist.md).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { createCanvas, type Image, loadImage } from "@napi-rs/canvas";
import exifr from "exifr";
import { describe, expect, it } from "vitest";

import {
  type Codec,
  exifDate,
  fit,
  FULL_EDGE,
  processPhoto,
  readTakenOn,
  THUMB_EDGE,
  UnreadablePhotoError,
} from "./process";

const FIXTURES = path.resolve(__dirname, "../../../e2e/fixtures");
const fixture = (name: string, type: string) =>
  new Blob([readFileSync(path.join(FIXTURES, name))], { type });

const skiaCodec: Codec<Image> = {
  decode: async (file) => loadImage(Buffer.from(await file.arrayBuffer())),
  encode: async (image, width, height, quality) => {
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    const bytes = await canvas.encode("jpeg", Math.round(quality * 100));
    return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
  },
};

async function bytes(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

describe("processPhoto (GPS strip)", () => {
  it("the fixture really carries GPS and a capture date", async () => {
    const original = await bytes(fixture("gps.jpg", "image/jpeg"));
    const gps = await exifr.gps(original);
    expect(gps?.latitude).toBeCloseTo(30.267, 2);
    expect(gps?.longitude).toBeCloseTo(-97.742, 2);
  });

  it("re-encodes to a 2048px JPEG and a 480px thumbnail with no EXIF at all", async () => {
    const result = await processPhoto(fixture("gps.jpg", "image/jpeg"), skiaCodec);

    expect(result.takenOn).toBe("2026-10-10");
    for (const [blob, edge] of [
      [result.full, FULL_EDGE],
      [result.thumb, THUMB_EDGE],
    ] as const) {
      const out = await bytes(blob);
      expect(blob.type).toBe("image/jpeg");
      expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      const image = await loadImage(out);
      expect(Math.max(image.width, image.height)).toBe(edge);
      expect(image.width / image.height).toBeCloseTo(1.5, 2);

      // No GPS block, no EXIF block, no APP1 "Exif" segment anywhere in the file.
      expect(await exifr.gps(out)).toBeUndefined();
      expect(await exifr.parse(out, { gps: true, tiff: true, exif: true })).toBeUndefined();
      expect(out.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    }
  });

  it("reads the HEIC capture date, and refuses a photo it can't decode", async () => {
    const heic = fixture("gps.heic", "image/heic");
    expect(await readTakenOn(heic)).toBe("2026-10-10");
    await expect(processPhoto(heic, skiaCodec)).rejects.toBeInstanceOf(UnreadablePhotoError);
  });

  it("has no date for a file without EXIF", async () => {
    expect(await readTakenOn(new Blob([new Uint8Array([1, 2, 3])]))).toBeNull();
  });

  it("releases the decoded image even when encoding fails", async () => {
    let released = 0;
    const codec: Codec = {
      decode: async () => ({ width: 10, height: 10 }),
      encode: async () => {
        throw new Error("canvas lost");
      },
      release: () => {
        released += 1;
      },
    };
    await expect(processPhoto(new Blob([]), codec)).rejects.toThrow("canvas lost");
    expect(released).toBe(1);
  });
});

describe("fit", () => {
  it("scales the long edge down and never up", () => {
    expect(fit(4032, 3024, 2048)).toEqual([2048, 1536]);
    expect(fit(3024, 4032, 480)).toEqual([360, 480]);
    expect(fit(800, 600, 2048)).toEqual([800, 600]);
    expect(fit(10_000, 1, 480)).toEqual([480, 1]);
  });
});

describe("exifDate", () => {
  it("keeps the date part only", () => {
    expect(exifDate("2026:10:10 23:59:59")).toBe("2026-10-10");
    expect(exifDate("2026-01-31T08:00:00")).toBe("2026-01-31");
  });

  it("drops anything that isn't a plausible date", () => {
    expect(exifDate(undefined)).toBeNull();
    expect(exifDate(new Date())).toBeNull();
    expect(exifDate("0000:00:00 00:00:00")).toBeNull();
    expect(exifDate("2026:13:01 00:00:00")).toBeNull();
    expect(exifDate("2026:12:00 00:00:00")).toBeNull();
    expect(exifDate("garbage")).toBeNull();
  });
});
