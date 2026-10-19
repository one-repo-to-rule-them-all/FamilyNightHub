// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asked: string[] = [];
const forgotPin = vi.fn(async (id: string) => {
  asked.push(id);
  return {};
});
vi.mock("@/lib/api", () => ({ api: { forgotPin: (id: string) => forgotPin(id) } }));

const { LockedState } = await import("./pin-states");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);

const ava = { id: "p1", name: "Ava", avatar_emoji: "🦄", color: "#a855f7" };

let root: Root;
let host: HTMLDivElement;
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function render(props: { onAsked?: () => void; onBack?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <LockedState
          person={ava}
          onAsked={props.onAsked ?? (() => {})}
          onBack={props.onBack ?? (() => {})}
        />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  forgotPin.mockClear();
  asked.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("LockedState (guest-flow §5 S5, owner feedback on #70)", () => {
  it("has Forgot PIN as the one primary, with what it does under it", () => {
    render();
    const primaries = host.querySelectorAll('[data-testid="primary-action"]');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].textContent).toBe("Forgot PIN");
    const helper = document.getElementById(primaries[0].getAttribute("aria-describedby") ?? "");
    expect(helper?.textContent).toBe("We'll ask the family admin to reset it.");
    expect(host.textContent).not.toContain("Ask the family admin to reset your PIN");
  });

  it("puts Back to everyone first, above the person, so it is on screen without scrolling", () => {
    const onBack = vi.fn();
    render({ onBack });
    const section = host.querySelector('[data-screen="locked"]');
    const back = q("locked-back");
    expect(back?.textContent).toBe("Back to everyone");
    expect(section?.firstElementChild).toBe(back);
    act(() => back?.click());
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("Forgot PIN asks the family admin for this person, then moves on", async () => {
    const onAsked = vi.fn();
    render({ onAsked });
    await act(async () => q("primary-action")?.click());
    expect(asked).toEqual(["p1"]);
    expect(onAsked).toHaveBeenCalledOnce();
  });
});
