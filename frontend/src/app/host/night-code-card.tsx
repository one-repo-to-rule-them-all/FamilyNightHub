"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { api, type ApiError, type NightStatus } from "@/lib/api";
import { recallNightCode, rememberNightCode } from "@/lib/night-code-handoff";

/**
 * The night code, as far as this browser knows it. The API hands it out once (create or rotate)
 * and keeps only a hash, so a host who opens the night in another tab or phone sees "rotate to
 * see a new one" instead (04-frontend.md "Night code on the TV").
 */
export function NightCodeCard({
  sessionId,
  status,
  initialCode,
}: {
  sessionId: string;
  status: NightStatus;
  initialCode?: string | null;
}) {
  const [code, setCode] = useState<string | null>(() => initialCode ?? recallNightCode(sessionId));
  const rotate = useMutation<{ night_code: string }, ApiError>({
    mutationFn: () => api.rotateNightCode(sessionId),
    onSuccess: ({ night_code }) => {
      rememberNightCode(sessionId, night_code);
      setCode(night_code);
    },
  });
  const rotatable = status !== "closed";

  return (
    <section
      aria-labelledby={`night-code-${sessionId}`}
      className="flex flex-col gap-3 rounded-2xl bg-card p-5 ring-1 ring-foreground/10"
    >
      <h2 id={`night-code-${sessionId}`} className="text-base text-muted-foreground">
        Tonight&apos;s code
      </h2>
      {code ? (
        <>
          <p
            data-testid="night-code"
            className="tabular font-mono text-5xl font-semibold tracking-[0.25em]"
          >
            {code}
          </p>
          <p className="text-sm text-muted-foreground">
            Shown once: Family Night keeps only a scrambled copy. It stays in this tab until you
            close it, and goes to the TV if you use this browser as the TV.
          </p>
        </>
      ) : (
        <p className="text-base text-muted-foreground" data-testid="night-code-hidden">
          The code was shown when the night was created. Lost it? Rotate to get a new one; the old
          one stops working.
        </p>
      )}
      <ApiErrorNotice error={rotate.error} />
      {rotatable ? (
        <Button
          variant="outline"
          size="tap"
          disabled={rotate.isPending}
          onClick={() => rotate.mutate()}
        >
          {rotate.isPending ? "Rotating…" : "Rotate code"}
        </Button>
      ) : null}
    </section>
  );
}
