// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PersonTile, Profile } from "@/lib/api";

const me = { id: "p1", name: "RooDog", current: true, binding: "mine" } as PersonTile;
const lulu = {
  id: "p2",
  name: "Lulu",
  avatar_emoji: "🐼",
  color: "#ec4899",
  is_guest: true,
  created_at: "2026-03-14T12:00:00Z",
  stats: {
    nights_joined: 1,
    ballots_cast: 1,
    winners_picked: 0,
    photos_uploaded: 0,
    ratings_given: 0,
    average_rating_given: null,
  },
  nights: [],
  albums: [],
} as unknown as Profile;

const state: { search: string; replace: ReturnType<typeof vi.fn> } = {
  search: "",
  replace: vi.fn(),
};
const api = { profile: vi.fn(async () => lulu) };

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: state.replace }),
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-phone", () => ({
  usePhonePeople: () => ({ people: { isSuccess: true, data: [me] }, current: me }),
}));
vi.mock("@/components/home/guest-shell", () => ({
  GuestShell: ({
    screen,
    back,
    children,
  }: {
    screen: string;
    back?: { href: string; label: string };
    children: React.ReactNode;
  }) => (
    <main data-screen={screen}>
      {back ? (
        <a data-testid="back" href={back.href}>
          {back.label}
        </a>
      ) : null}
      {children}
    </main>
  ),
}));

const { PersonProfile } = await import("./person-profile");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const back = () => host.querySelector<HTMLAnchorElement>('[data-testid="back"]');

async function render(personId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <PersonProfile personId={personId} />
      </QueryClientProvider>,
    ),
  );
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

beforeEach(() => {
  state.search = "";
  state.replace = vi.fn();
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("A person's profile (H5)", () => {
  it("shows the profile inside the shell, ‹ back to Family history", async () => {
    await render("p2");
    expect(host.querySelector('main[data-screen="profile"]')).not.toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Lulu");
    expect(host.textContent).toContain("Guest since");
    expect(back()?.getAttribute("href")).toBe("/history?tab=family");
    expect(state.replace).not.toHaveBeenCalled();
  });

  it("goes back to Me when opened from Me", async () => {
    state.search = "from=me";
    await render("p2");
    expect(back()?.getAttribute("href")).toBe("/me");
  });

  it("redirects your own id to /me (AC-H5.4)", async () => {
    await render("p1");
    expect(state.replace).toHaveBeenCalledWith("/me");
    expect(api.profile).not.toHaveBeenCalled();
  });
});
