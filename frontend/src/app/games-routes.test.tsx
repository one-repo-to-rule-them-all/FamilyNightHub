// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three per-kind dispatchers (phone, host, TV) must not mount the jar's screens while the
 * game's kind is unknown: they fire jar-only requests (a 404 on a bingo round) and flash.
 */
const mocks = vi.hoisted(() => ({ resolveGame: (kind: string): void => void kind }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: {
    game: vi.fn(
      () =>
        new Promise<{ kind: string }>((resolve) => {
          mocks.resolveGame = (kind) => resolve({ kind });
        }),
    ),
  },
}));

function marker(name: string) {
  function Marker() {
    return <div data-testid={name} />;
  }
  return Marker;
}
vi.mock("@/app/(public)/games/[game]/jar-screen", () => ({ JarScreen: marker("jar") }));
vi.mock("@/app/(public)/games/[game]/bingo-screen", () => ({ BingoScreen: marker("bingo") }));
vi.mock("@/app/(public)/games/[game]/scatter-screen", () => ({ ScatterScreen: marker("scatter") }));
vi.mock("@/app/host/games/[game]/jar-host", () => ({ JarHost: marker("jar") }));
vi.mock("@/app/host/games/[game]/bingo-host", () => ({ BingoHost: marker("bingo") }));
vi.mock("@/app/host/games/[game]/scatter-host", () => ({ ScatterHost: marker("scatter") }));
vi.mock("@/app/tv/games/[game]/tv-jar", () => ({ TvJar: marker("jar") }));
vi.mock("@/app/tv/games/[game]/tv-bingo", () => ({ TvBingo: marker("bingo") }));
vi.mock("@/app/tv/games/[game]/tv-scatter", () => ({ TvScatter: marker("scatter") }));

import { GameRoute } from "@/app/(public)/games/[game]/game-route";
import { HostGameRoute } from "@/app/host/games/[game]/game-route";
import { TvGameRoute } from "@/app/tv/games/[game]/game-route";

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe.each([
  ["phone", GameRoute],
  ["host", HostGameRoute],
  ["TV", TvGameRoute],
])("%s route", (_name, Route) => {
  it("shows a loading state, and no kind's screen, until the kind is known", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Route gameId="g1" />
        </QueryClientProvider>,
      );
    });
    expect(q("game-loading")).not.toBeNull();
    expect(q("jar")).toBeNull();

    await act(async () => mocks.resolveGame("bingo"));
    await vi.waitFor(() => expect(q("game-loading")).toBeNull());
    expect(q("bingo")).not.toBeNull();
    expect(q("jar")).toBeNull();
  });

  it.each([
    ["gratitude_jar", "jar"],
    ["scattergories", "scatter"],
  ])("opens the %s screen", async (kind, id) => {
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Route gameId="g1" />
        </QueryClientProvider>,
      );
    });
    await act(async () => mocks.resolveGame(kind));
    await vi.waitFor(() => expect(q(id)).not.toBeNull());
  });
});
