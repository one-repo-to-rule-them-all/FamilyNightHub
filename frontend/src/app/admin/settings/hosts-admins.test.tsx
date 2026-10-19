// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminAccount } from "@/lib/api";

const owner: AdminAccount = {
  id: "a1",
  email: "owner@example.test",
  username: null,
  display_name: "Rodolfo",
  role: "admin",
  status: "active",
  is_you: true,
  invite_expires_at: null,
  created_at: "2026-10-01T00:00:00Z",
};
const host: AdminAccount = {
  ...owner,
  id: "a2",
  email: "host@example.test",
  display_name: "Rafa",
  role: "host",
  status: "invited",
  is_you: false,
  invite_expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
};

const state: { accounts: AdminAccount[] } = { accounts: [] };
const api = {
  adminAccounts: vi.fn(async () => state.accounts),
  inviteAccount: vi.fn(async (body: { email: string; display_name: string; role: string }) => ({
    ...host,
    id: "a3",
    email: body.email,
    display_name: body.display_name,
  })),
  resendInvite: vi.fn(async () => host),
  changeAccountRole: vi.fn(),
  removeAccount: vi.fn(async () => undefined),
};

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api,
}));

const { HostsAdmins } = await import("./hosts-admins");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

let root: Root;
let container: HTMLDivElement;
const q = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const row = (email: string) =>
  container.querySelector<HTMLElement>(`[data-account="${email}"]`) as HTMLElement;

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await Promise.resolve();
    });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <HostsAdmins />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  state.accounts = [owner, host];
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HostsAdmins", () => {
  it("lists accounts and protects the last admin", async () => {
    await render();
    const mine = row(owner.email);
    expect(mine.textContent).toContain("(you)");
    expect(mine.querySelector<HTMLSelectElement>("select")!.disabled).toBe(true);
    expect(mine.querySelector<HTMLButtonElement>('[data-testid="remove-account"]')!.disabled).toBe(
      true,
    );
    const theirs = row(host.email);
    expect(theirs.dataset.status).toBe("invited");
    expect(theirs.textContent).toContain("Invited. The link expires in 3 days.");
    expect(theirs.querySelector<HTMLSelectElement>("select")!.disabled).toBe(false);
    expect(theirs.textContent).toContain("Resend invite");
  });

  it("invites by email with a role and never asks for a password", async () => {
    await render();
    act(() => q("invite-account")!.click());
    const dialog = q("invite-dialog")!;
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
    const [email, name] = [...dialog.querySelectorAll<HTMLInputElement>("input:not([type=radio])")];
    act(() => dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(dialog.querySelector('[role="alert"]')!.textContent).toMatch(/email/);
    expect(api.inviteAccount).not.toHaveBeenCalled();

    act(() => {
      type(email, " new@example.test ");
      type(name, "Abuela");
    });
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    await settle();
    expect(api.inviteAccount.mock.calls[0][0]).toEqual({
      email: "new@example.test",
      display_name: "Abuela",
      role: "host",
    });
    expect(q("invite-sent")!.textContent).toContain("new@example.test");
  });

  it("removes access after a confirm", async () => {
    await render();
    act(() =>
      row(host.email).querySelector<HTMLButtonElement>('[data-testid="remove-account"]')!.click(),
    );
    const confirm = q("remove-account-confirm")!;
    expect(confirm.textContent).toContain("can't sign in any more");
    const button = [...confirm.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Remove access"),
    )!;
    await act(async () => button.click());
    await settle();
    expect(api.removeAccount).toHaveBeenCalledWith("a2");
  });
});
