"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { ROLE_HELP, ROLE_LABEL, accountStatus, inviteProblem, isLastAdmin } from "@/lib/accounts";
import { type AccountRole, type AdminAccount, type ApiError, type Schemas, api } from "@/lib/api";

export const ACCOUNTS_KEY = ["admin", "accounts"] as const;
const ROLES: AccountRole[] = ["host", "admin"];

/**
 * Hosts & admins (issue #71): the adults who sign in with a password. An admin invites one by
 * email with a role; the invitee gets a single-use link and chooses their own password, so nobody
 * here ever sets or sees it. Role changes and removals take effect on that person's next request.
 * The server refuses to remove or demote the last admin; the screen says so up front.
 */
export function HostsAdmins() {
  const accounts = useQuery<AdminAccount[], ApiError>({
    queryKey: ACCOUNTS_KEY,
    queryFn: api.adminAccounts,
  });
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<AdminAccount | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (accounts.isError) return <ApiErrorNotice error={accounts.error} />;
  if (accounts.isPending) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading accounts…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="hosts-admins">
      <p className="text-sm text-muted-foreground">
        Grown-ups who sign in with a password. Everyone else uses their PIN on a phone.
      </p>
      <ul className="flex flex-col divide-y divide-foreground/10">
        {accounts.data.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            lastAdmin={isLastAdmin(accounts.data, a)}
            onRemove={() => setRemoving(a)}
          />
        ))}
      </ul>
      {sentTo ? (
        <p role="status" className="text-sm" data-testid="invite-sent">
          Invite sent to {sentTo}. They choose their own password from the email.
        </p>
      ) : null}
      <Button
        variant="secondary"
        size="lg"
        className="self-start px-4"
        onClick={() => setInviting(true)}
        data-testid="invite-account"
      >
        Invite a host or admin…
      </Button>
      {inviting ? (
        <InviteDialog
          onClose={() => setInviting(false)}
          onSent={(email) => {
            setInviting(false);
            setSentTo(email);
          }}
        />
      ) : null}
      {removing ? <RemoveDialog account={removing} onClose={() => setRemoving(null)} /> : null}
    </div>
  );
}

function AccountRow({
  account,
  lastAdmin,
  onRemove,
}: {
  account: AdminAccount;
  lastAdmin: boolean;
  onRemove: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
  const role = useMutation<AdminAccount, ApiError, AccountRole>({
    mutationFn: (next) => api.changeAccountRole(account.id, next),
    onSuccess: () => {
      void refresh();
      // Stepping down yourself: the screen you're on becomes admin-only.
      if (account.is_you) void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const resend = useMutation<AdminAccount, ApiError>({
    mutationFn: () => api.resendInvite(account.id),
    onSuccess: () => void refresh(),
  });
  const [now] = useState(() => Date.now());

  return (
    <li
      className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
      data-account={account.email}
      data-status={account.status}
    >
      <div className="flex min-w-0 flex-col">
        <span className="font-medium">
          {account.display_name}
          {account.is_you ? <span className="text-muted-foreground"> (you)</span> : null}
        </span>
        <span className="text-sm break-all text-muted-foreground">{account.email}</span>
        <span className="text-sm text-muted-foreground">{accountStatus(account, now)}</span>
        {resend.isSuccess ? (
          <span role="status" className="text-sm">
            New link sent. The old one no longer works.
          </span>
        ) : null}
        <ApiErrorNotice error={role.error ?? resend.error} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-role`} className="sr-only">
          Role for {account.display_name}
        </label>
        <select
          id={`${id}-role`}
          value={account.role}
          disabled={role.isPending || lastAdmin}
          title={lastAdmin ? "The household needs at least one admin." : undefined}
          onChange={(event) => role.mutate(event.target.value as AccountRole)}
          className="h-10 rounded-lg border border-input bg-input/30 px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          data-testid="account-role"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {account.status === "invited" ? (
          <Button
            variant="ghost"
            size="lg"
            disabled={resend.isPending}
            onClick={() => resend.mutate()}
          >
            {resend.isPending ? "Sending…" : "Resend invite"}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="lg"
          disabled={lastAdmin}
          title={lastAdmin ? "The household needs at least one admin." : undefined}
          onClick={onRemove}
          data-testid="remove-account"
        >
          Remove…
        </Button>
      </div>
    </li>
  );
}

function InviteDialog({
  onClose,
  onSent,
}: {
  onClose: () => void;
  onSent: (email: string) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AccountRole>("host");
  const [problem, setProblem] = useState<string | null>(null);
  const invite = useMutation<AdminAccount, ApiError, Schemas["AccountInviteIn"]>({
    mutationFn: api.inviteAccount,
    onSuccess: (account) => {
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      onSent(account.email);
    },
  });

  return (
    <ModalDialog title="Invite a host or admin" onClose={onClose} testId="invite-dialog">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const reason = inviteProblem({ email, name });
          setProblem(reason);
          if (!reason && !invite.isPending) {
            invite.mutate({ email: email.trim(), display_name: name.trim(), role });
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-email`}>Email</Label>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="h-11"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-11"
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Role</legend>
          {ROLES.map((r) => (
            <label key={r} className="flex cursor-pointer items-start gap-3">
              <input
                type="radio"
                name={`${id}-role`}
                value={r}
                checked={role === r}
                onChange={() => setRole(r)}
                className="mt-1 size-4 shrink-0 accent-[var(--accent-cinema)]"
              />
              <span className="flex flex-col">
                <span className="font-medium">{ROLE_LABEL[r]}</span>
                <span className="text-sm text-muted-foreground">{ROLE_HELP[r]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-sm text-muted-foreground">
          They get an email with a link that works once and lasts 3 days. They choose their own
          password; you never see it.
        </p>
        {problem ? (
          <p role="alert" className="text-sm">
            {problem}
          </p>
        ) : null}
        <ApiErrorNotice error={invite.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" className="px-4" disabled={invite.isPending}>
            {invite.isPending ? "Sending…" : "Send invite"}
          </Button>
          <Button type="button" variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function RemoveDialog({ account, onClose }: { account: AdminAccount; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation<void, ApiError>({
    mutationFn: () => api.removeAccount(account.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      if (account.is_you) void queryClient.invalidateQueries({ queryKey: ["me"] });
      onClose();
    },
  });
  return (
    <ModalDialog
      title={`Remove ${account.display_name}?`}
      onClose={onClose}
      testId="remove-account-confirm"
    >
      <div className="flex flex-col gap-2 text-sm">
        <p>
          <strong>
            {account.is_you ? "You" : account.display_name} can&apos;t sign in any more
          </strong>
          , and any browser signed in as {account.is_you ? "you" : "them"} stops working right away.
        </p>
        <p className="text-muted-foreground">
          Past nights stay as they are. You can invite the same email again later; they&apos;ll
          choose a new password.
        </p>
      </div>
      <ApiErrorNotice error={remove.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          size="lg"
          className="px-4"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? "Removing…" : "Remove access"}
        </Button>
        <Button variant="ghost" size="lg" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </ModalDialog>
  );
}
