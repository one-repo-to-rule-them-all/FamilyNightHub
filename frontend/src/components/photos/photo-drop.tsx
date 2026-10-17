"use client";

import { Camera, Check, CircleAlert, ImagePlus, LoaderCircle, RotateCw, X } from "lucide-react";
import { useId } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { usePhotoUploads } from "@/hooks/use-photo-uploads";
import { type JobStatus } from "@/lib/photos/queue";
import { cn } from "@/lib/utils";

const STATE_TEXT: Record<JobStatus["state"], string> = {
  processing: "Getting it ready…",
  queued: "Waiting to upload…",
  uploading: "Uploading…",
  waiting: "Connection hiccup, trying again…",
  done: "Added",
  failed: "Not added",
};

/**
 * "Add photos": a plain multi-file picker (no `capture`, never `image/heic` in `accept`, so iOS
 * offers the library and the camera both), then one progress row per file. On an empty album the
 * picker **is** the empty state (guest-flow spec §5 S13): one large tile, still the only primary.
 */
export function PhotoDrop({
  sessionId,
  personId,
  empty = false,
}: {
  sessionId: string;
  personId: string;
  empty?: boolean;
}) {
  const inputId = useId();
  const { rows, add, retry, dismiss } = usePhotoUploads(sessionId);

  return (
    <div className="flex flex-col gap-3">
      <label
        htmlFor={inputId}
        data-testid={empty ? "album-empty" : "primary-action"}
        className={cn(
          empty
            ? "flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-foreground/25 p-5 text-center"
            : cn(buttonVariants({ size: "tap" }), "w-full"),
          "cursor-pointer has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
        )}
      >
        {empty ? (
          <span data-testid="primary-action" className="flex flex-col items-center gap-2">
            <Camera aria-hidden className="size-10 text-cinema" />
            <span className="text-xl font-medium">No photos yet</span>
            <span className="text-muted-foreground">
              Tap here to add the first one: snacks, the couch crew, the screen!
            </span>
            <span className="sr-only">Add photos</span>
          </span>
        ) : (
          <>
            <ImagePlus aria-hidden />
            Add photos
          </>
        )}
        <input
          id={inputId}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          data-testid="photo-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // Clear it so picking the same photo again still fires a change.
            event.target.value = "";
            if (files.length > 0) add(files, personId);
          }}
        />
      </label>
      {rows.length > 0 ? (
        <ul aria-live="polite" className="flex flex-col gap-2" data-testid="upload-list">
          {rows.map((row) => (
            <UploadRow
              key={row.id}
              row={row}
              onRetry={() => retry(row.id)}
              onDismiss={() => dismiss(row.id)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function UploadRow({
  row,
  onRetry,
  onDismiss,
}: {
  row: JobStatus;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const busy = row.state !== "done" && row.state !== "failed";
  return (
    <li
      data-state={row.state}
      className="flex flex-col gap-2 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10"
    >
      <div className="flex items-center gap-3">
        {row.state === "done" ? (
          <Check aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        ) : row.state === "failed" ? (
          <CircleAlert aria-hidden className="size-5 shrink-0 text-destructive" />
        ) : (
          <LoaderCircle
            aria-hidden
            className="size-5 shrink-0 animate-spin text-muted-foreground"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{row.name}</p>
          <p className="text-sm text-muted-foreground" data-testid="upload-state">
            {row.error ?? STATE_TEXT[row.state]}
          </p>
        </div>
        {row.state === "failed" ? (
          <Button
            variant="outline"
            size="tap"
            className="px-4"
            onClick={onRetry}
            aria-label={`Retry ${row.name}`}
          >
            <RotateCw aria-hidden />
            Retry
          </Button>
        ) : null}
        {!busy ? (
          <Button
            variant="ghost"
            size="tap"
            className="px-0"
            onClick={onDismiss}
            aria-label={`Clear ${row.name}`}
          >
            <X aria-hidden />
          </Button>
        ) : null}
      </div>
      {busy ? (
        <progress
          className="h-1.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-foreground/60 [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-foreground/60"
          aria-label={`Uploading ${row.name}`}
          max={1}
          value={row.state === "uploading" ? row.progress : undefined}
        />
      ) : null}
    </li>
  );
}
