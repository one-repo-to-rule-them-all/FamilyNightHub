// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { result: Record<string, unknown> } = { result: {} };

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/home/guest-shell", () => ({
  GuestShell: ({
    screen,
    handoff = "plain",
    back,
    children,
  }: {
    screen: string;
    handoff?: string;
    back?: { href: string; label: string };
    children: React.ReactNode;
  }) => (
    <main data-shell data-screen={screen} data-handoff={handoff} data-back={back?.href}>
      {children}
    </main>
  ),
}));
vi.mock("@/components/photos/photo-album", () => ({
  PhotoAlbum: () => <div data-testid="photo-album" />,
}));
vi.mock("@/components/api-error-notice", () => ({ ApiErrorNotice: () => <p role="alert" /> }));
vi.mock("@/hooks/use-live-session", () => ({ useLiveSession: () => state.result }));

const { AlbumScreen } = await import("./album-screen");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const main = () => host.querySelector<HTMLElement>("main");

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("AlbumScreen (guest-home §5 H6)", () => {
  it("sits in the shell with ‹ back to the night and the plain hand-off (AC-H3.11)", () => {
    state.result = {
      isPending: false,
      isError: false,
      live: "live",
      data: { id: "n1", status: "closed", title: "Fri", options: [], result: null },
    };
    act(() => root.render(<AlbumScreen sessionId="n1" />));
    expect(main()?.dataset.screen).toBe("album");
    expect(main()?.dataset.back).toBe("/s/n1");
    expect(main()?.dataset.handoff).toBe("plain");
    expect(host.querySelector('[data-testid="photo-album"]')).not.toBeNull();
  });

  it("keeps the shell while loading", () => {
    state.result = { isPending: true, isError: false };
    act(() => root.render(<AlbumScreen sessionId="n1" />));
    expect(main()?.hasAttribute("data-shell")).toBe(true);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("without a device it asks to join, outside the shell", () => {
    state.result = { isPending: false, isError: true, error: { status: 401 } };
    act(() => root.render(<AlbumScreen sessionId="n1" />));
    expect(main()?.hasAttribute("data-shell")).toBe(false);
    expect(main()?.dataset.screen).toBe("album");
    expect(host.textContent).toContain("Join a movie night");
  });
});
