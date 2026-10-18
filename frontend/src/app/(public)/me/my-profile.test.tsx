// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PersonTile, Profile } from "@/lib/api";

const me: PersonTile = {
  id: "p1",
  name: "RooDog",
  avatar_emoji: "🦊",
  color: "#3b82f6",
  is_guest: false,
  binding: "mine",
  has_pin: true,
  locked: false,
  current: true,
  can_rename: true,
  pin_reset: null,
};
const lulu: PersonTile = { ...me, id: "p2", name: "Lulu", current: false };

const profile: Profile = {
  id: "p1",
  name: "RooDog",
  avatar_emoji: "🦊",
  color: "#3b82f6",
  is_guest: false,
  created_at: "2026-03-14T12:00:00Z",
  stats: {
    nights_joined: 12,
    ballots_cast: 11,
    winners_picked: 5,
    photos_uploaded: 21,
    ratings_given: 9,
    average_rating_given: 4.3,
  },
  nights: [],
  albums: [],
} as Profile;

const state: {
  people: PersonTile[];
  noDevice: boolean;
  replace: ReturnType<typeof vi.fn>;
} = { people: [me], noDevice: false, replace: vi.fn() };

const api = {
  profile: vi.fn(async () => profile),
  updateSelf: vi.fn(async (_id: string, body: Partial<PersonTile>) => {
    // The server's answer, reflected in the next GET /people.
    state.people = state.people.map((p) => (p.id === me.id ? { ...p, ...body } : p));
    return state.people[0];
  }),
  renameSelf: vi.fn(),
  setPin: vi.fn(),
};

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: state.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-phone", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    PEOPLE_KEY: ["people"],
    usePhonePeople: () => {
      const people = useQuery({ queryKey: ["people"], queryFn: async () => state.people });
      return {
        people,
        current: people.data?.find((p) => p.current) ?? null,
        noDevice: state.noDevice,
      };
    },
  };
});
vi.mock("@/components/home/guest-shell", () => ({
  GuestShell: ({ screen, children }: { screen: string; children: React.ReactNode }) => (
    <main data-screen={screen}>{children}</main>
  ),
}));
vi.mock("@/components/night/switch-sheet", () => ({
  SwitchSheet: () => <dialog open data-testid="switch-sheet" />,
}));

const { MyProfile } = await import("./my-profile");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no modal dialogs; ModalDialog only needs showModal/close to exist.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

let root: Root;
let host: HTMLDivElement;
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`);

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <MyProfile />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

beforeEach(() => {
  state.people = [me, lulu];
  state.noDevice = false;
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

describe("Me (H4)", () => {
  it("shows the avatar, name, since, stats, Switch person and Change my PIN (AC-H5.1)", async () => {
    await render();
    expect(host.querySelector('main[data-screen="me"]')).not.toBeNull();
    expect(q("me-name")?.textContent).toBe("RooDog");
    expect(host.textContent).toContain("Family since");
    const stats = [...(q("profile-stats")?.querySelectorAll("dd") ?? [])].map((d) => d.textContent);
    expect(stats).toEqual(["12", "5", "4.3 ★", "21"]);
    expect(q("me-switch")?.textContent).toBe("Switch person");
    expect(q("me-pin")?.textContent).toBe("Change my PIN");
    expect(q("me-my-nights")?.getAttribute("href")).toBe("/history?tab=mine");
    expect(q("me-add")?.getAttribute("href")).toBe("/who");
    expect(host.querySelector('[data-testid="primary-action"]')).toBeNull();
  });

  it("offers Change my name only while can_rename, with the rename-once help", async () => {
    await render();
    expect(q("me-rename")).not.toBeNull();
    expect(host.textContent).toContain("You can change your name once.");

    act(() => root.unmount());
    root = createRoot(host);
    state.people = [{ ...me, can_rename: false }];
    await render();
    expect(q("me-rename")).toBeNull();
    expect(host.textContent).not.toContain("You can change your name once.");
  });

  it("lists the others on this phone, each linking to their profile", async () => {
    await render();
    expect(q("me-shared")?.textContent).toBe("Also on this phone: Lulu");
    expect(q("me-shared")?.querySelector("a")?.getAttribute("href")).toBe("/people/p2?from=me");
  });

  it("Switch person opens the switch sheet (AC-H5.2)", async () => {
    await render();
    expect(q("switch-sheet")).toBeNull();
    act(() => q("me-switch")!.click());
    expect(q("switch-sheet")).not.toBeNull();
  });

  it("Change picture saves one PATCH per tap and closes (AC-H5.3)", async () => {
    await render();
    act(() => q("change-picture")!.click());
    expect(q("picture-sheet")).not.toBeNull();
    act(() => byLabel("Picture 🐙")!.click());
    await settle();
    expect(api.updateSelf).toHaveBeenCalledTimes(1);
    expect(api.updateSelf).toHaveBeenCalledWith("p1", { avatar_emoji: "🐙" });
    expect(q("picture-sheet")).toBeNull();
    expect(q("me-rename")).not.toBeNull();
  });

  it("changes the picture any number of times, colour too (AC-H5.5)", async () => {
    await render();
    for (const label of ["Picture 🐼", "Picture 🦖", "Colour Teal"]) {
      act(() => q("change-picture")!.click());
      act(() => byLabel(label)!.click());
      await settle();
    }
    expect(api.updateSelf).toHaveBeenCalledTimes(3);
    expect(api.updateSelf).toHaveBeenLastCalledWith("p1", { color: "#14b8a6" });
    act(() => q("change-picture")!.click());
    expect(byLabel("Picture 🦖")?.getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("Colour Teal")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("goes back to the resolver when nobody is current on this phone", async () => {
    state.people = [{ ...me, current: false }];
    await render();
    expect(state.replace).toHaveBeenCalledWith("/");
    expect(q("me-name")).toBeNull();
  });
});
