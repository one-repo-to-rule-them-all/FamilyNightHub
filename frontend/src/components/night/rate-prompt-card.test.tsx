// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const ratings = { attended: true };
vi.mock("@/lib/api", () => ({
  api: {
    nights: async () => [
      { id: "n1", winner: { title: "Paddington 2", poster_path: null }, status: "closed" },
    ],
    people: async () => [{ id: "p1", name: "RooDog", binding: "mine" }],
    myRatings: async () => [{ person_id: "p1", score: null, attended: ratings.attended }],
  },
}));

const { RatePromptCard } = await import("./rate-prompt-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function render(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  );
  // Let the three reads settle (people and ratings wait for the night).
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(q("rate-prompt")).not.toBeNull();
  });
}

beforeEach(() => {
  ratings.attended = true;
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("RatePromptCard", () => {
  it("is the filled button by default", async () => {
    await render(<RatePromptCard />);
    expect(q("rate-prompt-go")?.getAttribute("href")).toBe("/s/n1#rate");
    expect(q("rate-prompt-go")?.textContent).toBe("Rate it, RooDog");
    expect(q("rate-prompt-go")?.className).not.toContain("bg-secondary");
  });

  it("renders its button as secondary on Home (variant)", async () => {
    await render(<RatePromptCard variant="secondary" />);
    expect(q("rate-prompt-go")?.className).toContain("bg-secondary");
  });

  it("hides every mounted prompt after Not now", async () => {
    await render(
      <>
        <RatePromptCard />
        <RatePromptCard />
      </>,
    );
    expect(host.querySelectorAll('[data-testid="rate-prompt"]')).toHaveLength(2);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Not now"]')?.click());
    expect(host.querySelectorAll('[data-testid="rate-prompt"]')).toHaveLength(0);
  });

  it("asks nobody who wasn't part of the night (issue #91)", async () => {
    ratings.attended = false;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RatePromptCard />
        </QueryClientProvider>,
      ),
    );
    // Let all three reads settle; the ratings read says not attended, so nothing is owed.
    await vi.waitFor(() =>
      expect(client.getQueryState(["night", "n1", "ratings"])?.status).toBe("success"),
    );
    await act(async () => {});
    expect(q("rate-prompt")).toBeNull();
  });
});
