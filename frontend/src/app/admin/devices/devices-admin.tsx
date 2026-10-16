"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tv } from "lucide-react";
import { useId, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { deviceName, lastSeen } from "@/lib/admin";
import { type AdminDevice, type ApiError, api } from "@/lib/api";

import { AdminQueryError } from "../admin-error";

const DEVICES_KEY = ["admin", "devices"] as const;

export function DevicesAdmin() {
  const devices = useQuery<AdminDevice[], ApiError>({
    queryKey: DEVICES_KEY,
    queryFn: api.adminDevices,
  });
  const [labelling, setLabelling] = useState<AdminDevice | null>(null);
  const [revoking, setRevoking] = useState<AdminDevice | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (devices.isError) return <AdminQueryError error={devices.error} />;
  if (devices.isPending) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading devices…
      </p>
    );
  }

  const now = new Date();
  const columns: Column<AdminDevice>[] = [
    {
      key: "device",
      header: "Device",
      rowHeader: true,
      cell: (d) => (
        <span className="flex flex-wrap items-center gap-2">
          <span>{deviceName(d)}</span>
          {d.is_tv ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
              <Tv aria-hidden className="size-3" />
              TV
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "people",
      header: "People",
      cell: (d) =>
        d.people.length === 0 ? (
          <span className="text-muted-foreground">Nobody</span>
        ) : (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {d.people.map((p) => (
              <li key={p.person_id} className="whitespace-nowrap">
                <span aria-hidden>{p.avatar_emoji}</span> {p.name}
                {p.status === "pending" ? (
                  <span className="text-muted-foreground"> (waiting for approval)</span>
                ) : null}
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: "last-seen",
      header: "Last seen",
      className: "whitespace-nowrap",
      cell: (d) => (
        <time
          dateTime={d.last_seen_at ?? undefined}
          title={d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : undefined}
        >
          {lastSeen(d.last_seen_at, now)}
        </time>
      ),
    },
    {
      key: "status",
      header: "Status",
      className: "whitespace-nowrap",
      cell: (d) =>
        d.revoked_at ? (
          <span className="text-destructive">
            Revoked {new Date(d.revoked_at).toLocaleDateString()}
          </span>
        ) : (
          <span className="text-muted-foreground">Active</span>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "text-right whitespace-nowrap",
      cell: (d) =>
        d.revoked_at ? null : (
          <span className="inline-flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLabelling(d)}
              aria-label={`Rename ${deviceName(d)}`}
            >
              Rename
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setRevoking(d)}
              aria-label={`Revoke ${deviceName(d)}`}
            >
              Revoke
            </Button>
          </span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Every phone and TV that has joined, most recently seen first. Revoke one that is lost or no
        longer used.
      </p>
      <p aria-live="polite" data-testid="devices-notice" className="empty:hidden">
        {notice}
      </p>
      <DataTable
        caption={`Devices (${devices.data.length})`}
        columns={columns}
        rows={devices.data}
        rowKey={(d) => d.id}
        rowProps={(d) => ({
          "data-device": deviceName(d),
          "data-revoked": String(d.revoked_at !== null),
          className: d.revoked_at ? "text-muted-foreground" : undefined,
        })}
        empty="No phone has joined yet."
      />
      {labelling ? (
        <LabelDevice
          device={labelling}
          onDone={(saved) => {
            setLabelling(null);
            if (saved) setNotice(`Renamed to ${deviceName(saved)}.`);
          }}
        />
      ) : null}
      {revoking ? (
        <RevokeDevice
          device={revoking}
          onDone={(revoked) => {
            setRevoking(null);
            if (revoked) setNotice(`Revoked ${deviceName(revoked)}.`);
          }}
        />
      ) : null}
    </div>
  );
}

function LabelDevice({
  device,
  onDone,
}: {
  device: AdminDevice;
  onDone: (saved: AdminDevice | null) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(device.label ?? "");
  const save = useMutation<AdminDevice, ApiError, string>({
    mutationFn: (value) => api.updateDevice(device.id, value.trim() || null),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
      onDone(saved);
    },
  });

  return (
    <ModalDialog title={`Rename ${deviceName(device)}`} onClose={() => onDone(null)}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!save.isPending) save.mutate(label);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-label`}>Label</Label>
          <Input
            id={`${id}-label`}
            value={label}
            maxLength={80}
            placeholder="Ava's phone"
            onChange={(event) => setLabel(event.target.value)}
            className="h-11"
          />
          <p className="text-sm text-muted-foreground">Leave it empty to clear the label.</p>
        </div>
        <ApiErrorNotice error={save.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" className="px-4" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          <Button type="button" variant="ghost" size="lg" onClick={() => onDone(null)}>
            Cancel
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function RevokeDevice({
  device,
  onDone,
}: {
  device: AdminDevice;
  onDone: (revoked: AdminDevice | null) => void;
}) {
  const queryClient = useQueryClient();
  const revoke = useMutation<AdminDevice, ApiError>({
    mutationFn: () => api.revokeDevice(device.id),
    onSuccess: (revoked) => {
      void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
      onDone(revoked);
    },
  });
  const name = deviceName(device);
  const people = device.people.map((p) => p.name);

  return (
    <ModalDialog title={`Revoke ${name}?`} onClose={() => onDone(null)} testId="revoke-confirm">
      <div className="flex flex-col gap-2 text-sm">
        <p>
          <strong>This is final.</strong> {name} is signed out on its next request and can&apos;t be
          brought back.
        </p>
        <p>
          To use it again, the phone has to rejoin with a night code (or a host lets it in), and it
          comes back as a new device.
        </p>
        {people.length > 0 ? (
          <p className="text-muted-foreground">
            {people.join(", ")} can then be picked from any phone without approval.
          </p>
        ) : null}
      </div>
      <ApiErrorNotice error={revoke.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          size="lg"
          className="px-4"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
        >
          {revoke.isPending ? "Revoking…" : "Revoke for good"}
        </Button>
        <Button variant="ghost" size="lg" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </ModalDialog>
  );
}
