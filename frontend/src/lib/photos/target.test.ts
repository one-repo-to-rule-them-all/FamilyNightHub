import { describe, expect, it } from "vitest";

import {
  albumHref,
  albumTarget,
  isAlbumTarget,
  parseTarget,
  photosPath,
  TONIGHT_ALBUM,
} from "./target";

const SID = "6f1c8f9e-1111-4222-8333-944455556666";
const AID = "0a1b2c3d-1111-4222-8333-944455556666";

describe("photo targets (ADR-0019)", () => {
  it("keeps a bare id as a movie night, so jobs queued before albums still upload", () => {
    expect(parseTarget(SID)).toEqual({ kind: "session", id: SID });
    expect(photosPath(SID)).toBe(`/sessions/${SID}/photos`);
    expect(isAlbumTarget(SID)).toBe(false);
  });

  it("routes album keys to the album endpoints", () => {
    expect(parseTarget(TONIGHT_ALBUM)).toEqual({ kind: "album", id: "tonight" });
    expect(photosPath(TONIGHT_ALBUM)).toBe("/albums/tonight/photos");
    expect(albumTarget(AID)).toBe(`album:${AID}`);
    expect(photosPath(albumTarget(AID))).toBe(`/albums/${AID}/photos`);
    expect(isAlbumTarget(albumTarget(AID))).toBe(true);
  });

  it("encodes ids into paths", () => {
    expect(photosPath("album:a/b")).toBe("/albums/a%2Fb/photos");
  });

  it("links albums on the phone", () => {
    expect(albumHref(null)).toBe("/photos/tonight");
    expect(albumHref(AID)).toBe(`/photos/${AID}`);
  });
});
