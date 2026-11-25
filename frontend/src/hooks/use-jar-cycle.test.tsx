// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Game } from "@/lib/api";

import { useJarCycle } from "./use-jar-cycle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Jar = NonNullable<Game["jar"]>;
const note = (id: string) => ({ id, body: id, author: null, revealed_at: "2026-11-25T12:00:00Z" });
const jar = (paused: number | null, count = 3): Jar => ({
  mode: "cycle",
  cycle: {
    anchor_at: "2026-11-25T12:00:00Z",
    server_now: "2026-11-25T12:00:30Z", // two dwells in: index 2
    dwell_seconds: 12,
    paused_index: paused,
  },
  note_count: count,
  revealed_count: count,
  remaining: 0,
  current: null,
  revealed: Array.from({ length: count }, (_, i) => note(`n${i}`)),
});

let root: Root;
let host: HTMLDivElement;
type Seen = { index: number; count: number; paused: boolean };
const seen = (): Seen => JSON.parse(host.textContent ?? "null") as Seen;

function Probe({ value }: { value: Jar | null }) {
  return <>{JSON.stringify(useJarCycle(value))}</>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T09:00:00Z")); // the device clock is hours off the server
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("useJarCycle", () => {
  it("starts on the note the server clock says, whatever the device clock", () => {
    act(() => root.render(<Probe value={jar(null)} />));
    expect(seen()).toEqual({ index: 2, count: 3, paused: false });
  });

  it("moves on by itself and wraps, with no new snapshot", () => {
    act(() => root.render(<Probe value={jar(null)} />));
    act(() => void vi.advanceTimersByTime(6_000)); // 36 s into the cycle: 3 dwells -> wraps to 0
    expect(seen().index).toBe(0);
    act(() => void vi.advanceTimersByTime(12_000));
    expect(seen().index).toBe(1);
  });

  it("holds the paused index and does not move", () => {
    act(() => root.render(<Probe value={jar(1)} />));
    expect(seen()).toEqual({ index: 1, count: 3, paused: true });
    act(() => void vi.advanceTimersByTime(60_000));
    expect(seen().index).toBe(1);
  });

  it("is index 0 with no cycle and clamps a paused index past the end", () => {
    act(() => root.render(<Probe value={null} />));
    expect(seen()).toEqual({ index: 0, count: 0, paused: false });
    act(() => root.render(<Probe value={jar(9, 2)} />));
    expect(seen().index).toBe(1);
  });
});
