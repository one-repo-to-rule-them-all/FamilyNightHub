// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/api";

const admin: Account = {
  id: "a1",
  email: "parent@example.test",
  username: null,
  has_password: true,
  display_name: "Parent",
  role: "admin",
  household_name: "The Test Family",
  consent: {
    terms_version: "2026-10-19",
    privacy_version: "2026-10-19",
    account_accepted: false,
    household_accepted: false,
  },
};

const api = { consent: vi.fn(async () => ({ ...admin.consent, account_accepted: true })) };

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { ConsentGate } = await import("./consent-gate");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);

let root: Root;
let host: HTMLDivElement;
const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel);

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await Promise.resolve();
    });
}

async function render(account: Account) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ConsentGate account={account} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function check(testId: string) {
  act(() => q<HTMLInputElement>(`[data-testid="${testId}"]`)!.click());
}

const submit = () => q<HTMLButtonElement>('button[type="submit"]')!;

beforeEach(() => {
  api.consent.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ConsentGate", () => {
  it("links both documents with the versions it will accept", async () => {
    await render(admin);
    const links = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/legal/terms", "/legal/privacy"]);
    expect(host.textContent).toContain("version 2026-10-19");
  });

  it("an admin must confirm guardianship before accepting", async () => {
    await render(admin);
    expect(submit().disabled).toBe(true);
    check("consent-read");
    expect(submit().disabled).toBe(true);
    check("consent-guardian");
    expect(submit().disabled).toBe(false);

    await act(async () => submit().click());
    await settle();
    expect(api.consent).toHaveBeenCalledWith(
      { terms_version: "2026-10-19", privacy_version: "2026-10-19", guardian: true },
      expect.anything(),
    );
  });

  it("a host only accepts the documents and never claims guardianship", async () => {
    await render({ ...admin, role: "host" });
    expect(q('[data-testid="consent-guardian"]')).toBeNull();
    check("consent-read");
    await act(async () => submit().click());
    await settle();
    expect(api.consent).toHaveBeenCalledWith(
      { terms_version: "2026-10-19", privacy_version: "2026-10-19", guardian: false },
      expect.anything(),
    );
  });
});
