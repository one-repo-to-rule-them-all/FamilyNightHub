"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogIn, LogOut, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { type ApiError, type PlatformHousehold, type PlatformMe, api } from "@/lib/api";

const ME_KEY = ["platform", "me"] as const;
const HOUSEHOLDS_KEY = ["platform", "households"] as const;

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

/**
 * The platform owner's home (ADR-0016): every household's metadata and counts (ADR-0017 §6),
 * and the operator actions. Entering a household opens its family portal as its admin, under
 * the platform banner, and is logged where the family sees it.
 */
export function PlatformHome() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery<PlatformMe, ApiError>({ queryKey: ME_KEY, queryFn: api.platformMe });
  const households = useQuery<PlatformHousehold[], ApiError>({
    queryKey: HOUSEHOLDS_KEY,
    queryFn: api.platformHouseholds,
    enabled: me.isSuccess,
  });
  const [creating, setCreating] = useState(false);
  const [disabling, setDisabling] = useState<PlatformHousehold | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const signedOut = me.error?.status === 401;

  useEffect(() => {
    if (signedOut) router.replace("/platform/login");
  }, [signedOut, router]);

  const enter = useMutation<PlatformMe, ApiError, PlatformHousehold>({
    mutationFn: (h) => api.enterHousehold(h.id),
    onSuccess: () => {
      // Every cached family query belongs to whichever household was open before.
      queryClient.removeQueries();
      router.push("/admin/people");
    },
  });
  const enable = useMutation<PlatformHousehold, ApiError, PlatformHousehold>({
    mutationFn: (h) => api.enableHousehold(h.id),
    onSuccess: (h) => {
      void queryClient.invalidateQueries({ queryKey: HOUSEHOLDS_KEY });
      setNotice(`${h.name} is switched back on. Its admins were emailed.`);
    },
  });
  const rotate = useMutation<void, ApiError, PlatformHousehold>({
    mutationFn: (h) => api.rotateHouseholdSlug(h.id),
    onSuccess: (_, h) =>
      setNotice(`${h.name} has a new join link. The old fridge QR no longer works.`),
  });
  const logout = useMutation<void, ApiError, void>({
    mutationFn: api.platformLogout,
    onSuccess: () => {
      queryClient.removeQueries();
      router.replace("/platform/login");
    },
  });

  const columns: Column<PlatformHousehold>[] = [
    {
      key: "name",
      header: "Household",
      rowHeader: true,
      cell: (h) => (
        <span className="flex flex-col">
          <span className="font-medium">{h.name}</span>
          {h.disabled_at ? (
            <span className="text-xs text-destructive">Switched off {when(h.disabled_at)}</span>
          ) : null}
          {h.delete_after ? (
            <span className="text-xs text-destructive">Deleting {when(h.delete_after)}</span>
          ) : null}
        </span>
      ),
    },
    { key: "people", header: "People", cell: (h) => h.people, className: "text-right" },
    { key: "devices", header: "Phones", cell: (h) => h.devices, className: "text-right" },
    { key: "nights", header: "Nights", cell: (h) => h.nights, className: "text-right" },
    { key: "photos", header: "Photos", cell: (h) => h.photos, className: "text-right" },
    { key: "active", header: "Last active", cell: (h) => when(h.last_activity) },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      cell: (h) => (
        <span className="flex flex-wrap justify-end gap-1">
          <Button size="sm" disabled={enter.isPending} onClick={() => enter.mutate(h)}>
            <LogIn aria-hidden />
            Enter
          </Button>
          {h.disabled_at ? (
            <Button size="sm" variant="ghost" onClick={() => enable.mutate(h)}>
              Switch on
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setDisabling(h)}>
              Switch off…
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm(`Give ${h.name} a new join link? Their printed QR stops working.`))
                rotate.mutate(h);
            }}
          >
            New join link
          </Button>
        </span>
      ),
    },
  ];

  return (
    <main
      className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6"
      data-screen="platform"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Platform</h1>
          {me.data ? (
            <p className="text-sm text-muted-foreground">
              {me.data.email} · session ends{" "}
              {new Date(me.data.expires_at).toLocaleTimeString([], { timeStyle: "short" })}
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button size="lg" className="px-4" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            New household
          </Button>
          <Button size="lg" variant="ghost" onClick={() => logout.mutate()}>
            <LogOut aria-hidden />
            Sign out
          </Button>
        </div>
      </header>
      <p aria-live="polite" className="empty:hidden" data-testid="platform-notice">
        {notice}
      </p>
      <ApiErrorNotice error={enter.error ?? enable.error ?? rotate.error ?? households.error} />
      {households.data ? (
        <DataTable
          caption="Households"
          columns={columns}
          rows={households.data}
          rowKey={(h) => h.id}
          empty="No households yet."
        />
      ) : (
        <p role="status" className="text-muted-foreground">
          Loading households…
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Counts only. Entering a household shows its family portal as its admin; the family sees each
        entry in its activity.
      </p>
      {creating ? (
        <CreateHousehold
          onClose={() => setCreating(false)}
          onCreated={(h) => {
            setCreating(false);
            setNotice(`Created ${h.name}. Its admin has an invite to set a password.`);
          }}
        />
      ) : null}
      {disabling ? (
        <DisableHousehold
          household={disabling}
          onClose={() => setDisabling(null)}
          onDone={(h) => {
            setDisabling(null);
            setNotice(`${h.name} is switched off. Its admins were emailed why.`);
          }}
        />
      ) : null}
    </main>
  );
}

function CreateHousehold({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (h: PlatformHousehold) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const create = useMutation<PlatformHousehold, ApiError, void>({
    mutationFn: () => api.createHousehold({ name, admin_name: adminName, admin_email: adminEmail }),
    onSuccess: (h) => {
      void queryClient.invalidateQueries({ queryKey: HOUSEHOLDS_KEY });
      onCreated(h);
    },
  });
  const ready = name.trim() !== "" && adminName.trim() !== "" && adminEmail.includes("@");
  return (
    <ModalDialog title="New household" onClose={onClose} testId="create-household">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !create.isPending) create.mutate();
        }}
      >
        <p className="text-sm text-muted-foreground">
          Only for a family you know (ADR-0017). Their admin gets an invite to set a password, then
          accepts the Terms as a parent or guardian before anyone can be added.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-name`}>Household name</Label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-admin`}>Admin&apos;s name</Label>
          <Input
            id={`${id}-admin`}
            value={adminName}
            onChange={(e) => setAdminName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-email`}>Admin&apos;s email</Label>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="off"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
          />
        </div>
        <ApiErrorNotice error={create.error} />
        <div className="flex gap-2">
          <Button type="submit" size="lg" className="px-4" disabled={!ready || create.isPending}>
            {create.isPending ? "Creating…" : "Create and invite"}
          </Button>
          <Button type="button" variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function DisableHousehold({
  household,
  onClose,
  onDone,
}: {
  household: PlatformHousehold;
  onClose: () => void;
  onDone: (h: PlatformHousehold) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const disable = useMutation<PlatformHousehold, ApiError, void>({
    mutationFn: () => api.disableHousehold(household.id, { reason }),
    onSuccess: (h) => {
      void queryClient.invalidateQueries({ queryKey: HOUSEHOLDS_KEY });
      onDone(h);
    },
  });
  return (
    <ModalDialog
      title={`Switch off ${household.name}?`}
      onClose={onClose}
      testId="disable-household"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim() && !disable.isPending) disable.mutate();
        }}
      >
        <p className="text-sm">
          Nobody can sign in or join a night until it&apos;s switched back on. Nothing is deleted.
          The household&apos;s admins are emailed the reason below.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-reason`}>Why</Label>
          <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ApiErrorNotice error={disable.error} />
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="destructive"
            size="lg"
            className="px-4"
            disabled={!reason.trim() || disable.isPending}
          >
            {disable.isPending ? "Switching off…" : "Switch off"}
          </Button>
          <Button type="button" variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
