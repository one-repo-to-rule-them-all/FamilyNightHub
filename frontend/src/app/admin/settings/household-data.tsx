"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useId, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { type ApiError, type HouseholdDeletion, api } from "@/lib/api";

const DELETION_KEY = ["admin", "household-deletion"] as const;

/** "Monday, October 26" in the viewer's time zone. */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/**
 * ADR-0017 §4: download everything, or schedule the household's deletion. The delete waits
 * HOUSEHOLD_DELETE_GRACE_DAYS (7) with every admin emailed, and any admin can cancel until then.
 */
export function HouseholdData() {
  const deletion = useQuery<HouseholdDeletion, ApiError>({
    queryKey: DELETION_KEY,
    queryFn: api.householdDeletion,
  });
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-5" data-testid="household-data">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          A zip of everything the household holds: people, nights, votes, ratings and every original
          photo. Large albums take a while.
        </p>
        <a
          href="/api/v1/admin/export"
          download
          className="inline-flex h-10 items-center gap-2 self-start rounded-lg px-4 ring-1 ring-foreground/15 hover:bg-foreground/5"
          data-testid="export-download"
        >
          <Download aria-hidden className="size-4" />
          Download everything
        </a>
      </div>

      <div className="flex flex-col gap-2 border-t border-foreground/10 pt-4">
        <ApiErrorNotice error={deletion.error} />
        {deletion.data?.delete_after ? (
          <Scheduled deletion={deletion.data} />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Deleting the household erases its people, nights, votes and photos for good, after a
              7-day wait any admin can cancel. Download everything first if you want a copy.
            </p>
            <Button
              variant="ghost"
              className="self-start text-destructive"
              disabled={!deletion.data}
              onClick={() => setConfirming(true)}
              data-testid="delete-household"
            >
              Delete this household…
            </Button>
          </>
        )}
      </div>
      {confirming && deletion.data ? (
        <ScheduleDeletion
          householdName={deletion.data.household_name}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

function Scheduled({ deletion }: { deletion: HouseholdDeletion }) {
  const queryClient = useQueryClient();
  const cancel = useMutation<HouseholdDeletion, ApiError, void>({
    mutationFn: api.cancelHouseholdDeletion,
    onSuccess: (data) => queryClient.setQueryData(DELETION_KEY, data),
  });
  return (
    <div role="alert" className="flex flex-col gap-3" data-testid="deletion-scheduled">
      <p className="font-medium">
        {deletion.household_name} will be deleted on {day(deletion.delete_after!)}.
      </p>
      <p className="text-sm text-muted-foreground">
        {deletion.requested_by ?? "An admin"} asked for it. Every admin was emailed.
      </p>
      <ApiErrorNotice error={cancel.error} />
      <Button
        size="lg"
        className="self-start px-4"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate()}
      >
        {cancel.isPending ? "Cancelling…" : "Cancel the deletion"}
      </Button>
    </div>
  );
}

function ScheduleDeletion({
  householdName,
  onClose,
}: {
  householdName: string;
  onClose: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const schedule = useMutation<HouseholdDeletion, ApiError, void>({
    mutationFn: () => api.scheduleHouseholdDeletion({ household_name: name, password }),
    onSuccess: (data) => {
      queryClient.setQueryData(DELETION_KEY, data);
      onClose();
    },
    onError: () => setPassword(""),
  });
  const ready = name.trim().toLowerCase() === householdName.trim().toLowerCase() && password !== "";

  return (
    <ModalDialog
      title={`Delete ${householdName}?`}
      onClose={onClose}
      testId="delete-household-confirm"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !schedule.isPending) schedule.mutate();
        }}
      >
        <p className="text-sm">
          In 7 days, everything {householdName} holds is erased: people, nights, votes, ratings,
          phones and photos. Every admin is emailed now and can cancel until then.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-name`}>Type {householdName} to confirm</Label>
          <Input
            id={`${id}-name`}
            value={name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
            data-testid="delete-household-name"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-password`}>Your password</Label>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            data-testid="delete-household-password"
          />
        </div>
        <ApiErrorNotice error={schedule.error} />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="destructive"
            size="lg"
            className="px-4"
            disabled={!ready || schedule.isPending}
          >
            {schedule.isPending ? "Scheduling…" : "Delete in 7 days"}
          </Button>
          <Button type="button" variant="ghost" size="lg" onClick={onClose}>
            Keep it
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
