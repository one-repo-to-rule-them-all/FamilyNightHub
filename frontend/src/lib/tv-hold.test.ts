import { describe, expect, it } from "vitest";

import {
  holdElapsedMs,
  holdRemainingMs,
  serverElapsedMs,
  shouldLeaveTv,
  shouldReturnToEnded,
  TV_HOLD_MS,
} from "./tv-hold";

const ENDED = "2026-11-26T20:00:00Z";
const at = (s: number) => new Date(Date.parse(ENDED) + s * 1000).toISOString();
const ended = (serverS: number) => ({
  game_id: null,
  ended_game_id: "g1",
  ended_at: ENDED,
  server_now: at(serverS),
});

describe("tv hold", () => {
  it("holds for two minutes", () => {
    expect(TV_HOLD_MS).toBe(120_000);
  });
  it("stays while the game is the live target", () => {
    expect(shouldLeaveTv("g1", { game_id: "g1" }, null, 0)).toBe(false);
  });
  it("leaves at once for another game or Back to QR", () => {
    expect(shouldLeaveTv("g1", { game_id: "g2" }, null, 0)).toBe(true);
    expect(shouldLeaveTv("g1", { game_id: null, ended_game_id: null }, null, 0)).toBe(true);
  });
  it("holds a just-ended game, then leaves after the hold by the server's clock", () => {
    expect(shouldLeaveTv("g1", ended(5), null, 0)).toBe(false);
    expect(shouldLeaveTv("g1", ended(119), null, 0)).toBe(false);
    expect(shouldLeaveTv("g1", ended(120), null, 0)).toBe(true);
  });
  it("leaves after the hold by the TV's own clock even when the server answer is stale", () => {
    expect(shouldLeaveTv("g1", ended(5), 1_000, 1_000 + 60_000)).toBe(false);
    expect(shouldLeaveTv("g1", ended(5), 1_000, 1_000 + TV_HOLD_MS)).toBe(true);
  });
  it("measures elapsed and remaining time", () => {
    expect(serverElapsedMs(ended(30))).toBe(30_000);
    expect(serverElapsedMs({ ended_at: null, server_now: null })).toBeNull();
    expect(holdElapsedMs(ended(30), 0, 50_000)).toBe(50_000);
    expect(holdRemainingMs(ended(30), null, 0)).toBe(90_000);
    expect(holdRemainingMs(ended(500), null, 0)).toBe(0);
  });
  it("/tv returns to an ended game only during the hold and never after releasing it", () => {
    expect(shouldReturnToEnded(ended(10), new Set())).toBe(true);
    expect(shouldReturnToEnded(ended(10), new Set(["g1"]))).toBe(false);
    expect(shouldReturnToEnded(ended(200), new Set())).toBe(false);
    expect(shouldReturnToEnded({ ended_game_id: null }, new Set())).toBe(false);
  });
});
