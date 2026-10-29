// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FullscreenButton } from "./fullscreen-button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function stubFullscreen({
  element = null,
  enabled = true,
  request = vi.fn(() => Promise.resolve()),
}: {
  element?: Element | null;
  enabled?: boolean;
  request?: (() => Promise<void>) | undefined;
}) {
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: element });
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: enabled });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: request,
  });
  return request;
}

async function render() {
  await act(async () => root.render(<FullscreenButton />));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("FullscreenButton", () => {
  it("offers Full screen with the F11 hint, and asks the browser on click", async () => {
    const request = stubFullscreen({});
    await render();
    expect(q("tv-fullscreen-hint")?.textContent).toBe("or press F11");
    await act(async () => host.querySelector("button")!.click());
    expect(request).toHaveBeenCalledOnce();
  });

  it("hides once the page is full screen", async () => {
    stubFullscreen({});
    await render();
    expect(q("tv-fullscreen")).not.toBeNull();
    stubFullscreen({ element: document.documentElement });
    await act(async () => document.dispatchEvent(new Event("fullscreenchange")));
    expect(q("tv-fullscreen")).toBeNull();
  });

  it("stays hidden in the browser's own F11 full screen", async () => {
    stubFullscreen({});
    window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia;
    await render();
    expect(q("tv-fullscreen")).toBeNull();
  });

  it("falls back to the F11 hint when the browser refuses", async () => {
    stubFullscreen({ request: vi.fn(() => Promise.reject(new Error("denied"))) });
    await render();
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector("button")).toBeNull();
    expect(q("tv-fullscreen-hint")?.textContent).toBe("Press F11 for full screen");
  });

  it("shows only the hint without a Fullscreen API", async () => {
    stubFullscreen({ enabled: false, request: undefined });
    await render();
    expect(host.querySelector("button")).toBeNull();
    expect(q("tv-fullscreen-hint")?.textContent).toBe("Press F11 for full screen");
  });
});
