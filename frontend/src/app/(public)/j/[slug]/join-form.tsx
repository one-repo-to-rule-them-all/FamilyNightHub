"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PEOPLE_KEY } from "@/hooks/use-phone";
import { nightKey } from "@/hooks/use-live-session";
import { api, type ApiError, type JoinResult, type PersonTile } from "@/lib/api";
import { DEVICE_EXPIRED_COPY, isDeviceExpired } from "@/lib/device-idle";
import { codeFromQuery } from "@/lib/join-link";
import { recallLastJoin, rememberLastJoin } from "@/lib/last-join";
import { cleanNightCodeInput, completeNightCode, lookalikes } from "@/lib/night-code";

/**
 * S1, Join (guest-flow spec §5 S1). A phone that already has a device skips straight to the
 * resolver. A code from the TV QR (`?code=`, only when the admin turned it on) is pre-filled and
 * removed from the address bar at once, and still waits for one Join tap (owner decision §10.1).
 * A typed code submits by itself at the 6th valid character. A phone unused for 30 days (issue
 * #56) lands here from the resolver and is told why.
 */
export function JoinForm({ slug }: { slug: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const [wrong, setWrong] = useState(false);

  // Already in? A 200 means this phone has a device: go to the resolver (D1, AC-1.5).
  const probe = useQuery<PersonTile[], ApiError>({
    queryKey: PEOPLE_KEY,
    queryFn: api.people,
    retry: false,
  });
  const joined = probe.isSuccess;
  const expired = isDeviceExpired(probe.error);

  useEffect(() => {
    if (joined) router.replace("/?arrive=1");
  }, [joined, router]);

  useEffect(() => {
    // The door this browser came through, so `/` can offer it again after a cookie clear.
    if (recallLastJoin()?.slug !== slug) rememberLastJoin({ slug, householdName: null });
    // Read ?code= once, then drop it from the address bar and history (spec §5 S1).
    const params = new URLSearchParams(window.location.search);
    if (!params.has("code")) return;
    const fromQr = codeFromQuery(params);
    router.replace(`/j/${encodeURIComponent(slug)}`);
    if (fromQr) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the URL
      setCode(fromQr);
      setPrefilled(true);
    }
  }, [slug, router]);

  const join = useMutation<JoinResult, ApiError, string>({
    mutationFn: (nightCode) => api.join({ slug, night_code: nightCode }),
    onSuccess: async (result) => {
      rememberLastJoin({ slug, householdName: result.household_name });
      // JoinOut already names the night: warm it for the resolver (D2).
      void queryClient.prefetchQuery({
        queryKey: nightKey(result.session_id),
        queryFn: () => api.night(result.session_id),
      });
      await queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
      router.replace("/?arrive=1");
    },
    onError: (error) => {
      if (!isWrongCode(error)) return;
      setWrong(true);
      setPrefilled(false);
      setCode("");
      inputRef.current?.focus();
    },
  });

  const ready = completeNightCode(code);
  const misread = lookalikes(code);
  const slowMinutes =
    join.error?.status === 429 && join.error.retryAfter !== null
      ? Math.max(1, Math.ceil(join.error.retryAfter / 60))
      : null;
  const slow = join.error?.status === 429;

  if (probe.isPending || joined) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Checking this phone"
        className="h-40 animate-pulse rounded-2xl bg-muted"
      />
    );
  }

  return (
    <form
      data-screen="join"
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !join.isPending && !slow) join.mutate(ready);
      }}
    >
      {expired ? (
        <p role="status" className="text-lg" data-testid="join-expired">
          {DEVICE_EXPIRED_COPY.phone}
        </p>
      ) : null}
      <div className="flex flex-col gap-3">
        <Label htmlFor="night-code" className="text-base">
          Night code
        </Label>
        <Input
          ref={inputRef}
          id="night-code"
          name="night-code"
          value={code}
          autoFocus={!prefilled}
          disabled={slow}
          onChange={(event) => {
            const next = cleanNightCodeInput(event.target.value);
            setCode(next);
            setPrefilled(false);
            setWrong(false);
            const complete = completeNightCode(next);
            // A typed code joins by itself at the 6th valid character (spec §5 S1, AC-1.2).
            if (complete && !join.isPending) join.mutate(complete);
          }}
          placeholder="ABC234"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="go"
          aria-describedby="night-code-hint"
          aria-invalid={misread.length > 0 || wrong || undefined}
          className="h-16 text-center font-mono text-3xl tracking-[0.35em] uppercase md:text-3xl"
        />
        <p id="night-code-hint" aria-live="polite" className="text-sm text-muted-foreground">
          {misread.length > 0
            ? `Night codes never use ${misread.join(", ")}. Check the TV again.`
            : prefilled
              ? "We filled in tonight's code from the TV. Tap Join."
              : "Six letters and numbers. Spaces and dashes are fine."}
        </p>
      </div>
      {wrong ? (
        <p role="alert" className="text-lg" data-testid="join-wrong">
          That code didn&apos;t work. Check the TV: the code changes every movie night.
        </p>
      ) : null}
      {slow ? (
        <p role="alert" className="text-lg" data-testid="join-slow">
          Too many tries. Try again in{" "}
          <strong>
            {slowMinutes === null
              ? "a few minutes"
              : `${slowMinutes} minute${slowMinutes === 1 ? "" : "s"}`}
          </strong>
          , or ask the host to let this phone in.
        </p>
      ) : null}
      {join.error && !slow && !isWrongCode(join.error) ? (
        <ApiErrorNotice error={join.error} />
      ) : null}
      <Button
        type="submit"
        size="tap"
        className="w-full"
        disabled={!ready || join.isPending || slow}
        data-testid="primary-action"
      >
        {join.isPending ? "Joining…" : "Join"}
      </Button>
      <Link href="/login" className="text-sm text-muted-foreground underline underline-offset-4">
        Hosting tonight? Sign in
      </Link>
    </form>
  );
}

/** Any 4xx but the rate limit: the code was wrong, expired or from a closed night. */
function isWrongCode(error: ApiError): boolean {
  return error.status >= 400 && error.status < 500 && error.status !== 429;
}
