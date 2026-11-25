"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { type Account, type ApiError, type Consent, type Schemas, api } from "@/lib/api";

/**
 * ADR-0017 §2: shown in place of every portal screen until this account accepts the current
 * Terms and Privacy Policy. An admin also confirms they're a parent or legal guardian of the
 * children they add; that acceptance opens the household's gate (new people, phones, photos).
 * It sends back the versions it showed, so a page left open across a change is refused.
 */
export function ConsentGate({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const admin = account.role === "admin";
  const changed = account.consent.household_accepted || !admin;
  const [read, setRead] = useState(false);
  const [guardian, setGuardian] = useState(false);
  const accept = useMutation<Consent, ApiError, Schemas["ConsentIn"]>({
    mutationFn: api.consent,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });
  const ready = read && (!admin || guardian);

  return (
    <section className="flex max-w-xl flex-col gap-5" data-screen="consent">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          {changed ? "Before you go on" : "One step before your family joins"}
        </h1>
        <p className="text-lg text-muted-foreground">
          {admin
            ? "Family Night stores your children's names, votes and photos. Please read what that means, and who can see it."
            : "Please read the Terms and Privacy Policy for Family Night."}
        </p>
      </header>

      <ul className="flex flex-col gap-1 text-base">
        <li>
          <Link className="underline" href="/legal/terms" target="_blank">
            Terms
          </Link>{" "}
          <span className="text-sm text-muted-foreground">
            (version {account.consent.terms_version})
          </span>
        </li>
        <li>
          <Link className="underline" href="/legal/privacy" target="_blank">
            Privacy Policy
          </Link>{" "}
          <span className="text-sm text-muted-foreground">
            (version {account.consent.privacy_version})
          </span>
        </li>
      </ul>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !accept.isPending) {
            accept.mutate({
              terms_version: account.consent.terms_version,
              privacy_version: account.consent.privacy_version,
              guardian: admin && guardian,
            });
          }
        }}
      >
        <label className="flex items-start gap-3 text-base">
          <input
            type="checkbox"
            checked={read}
            onChange={(event) => setRead(event.target.checked)}
            className="mt-1 size-5 shrink-0 accent-[var(--accent-cinema)]"
            data-testid="consent-read"
          />
          I&apos;ve read and accept the Terms and the Privacy Policy.
        </label>
        {admin ? (
          <label className="flex items-start gap-3 text-base">
            <input
              type="checkbox"
              checked={guardian}
              onChange={(event) => setGuardian(event.target.checked)}
              className="mt-1 size-5 shrink-0 accent-[var(--accent-cinema)]"
              data-testid="consent-guardian"
            />
            I&apos;m a parent or legal guardian of the children I add, and I supervise their use.
          </label>
        ) : null}
        <ApiErrorNotice error={accept.error} />
        <Button
          type="submit"
          size="lg"
          disabled={!ready || accept.isPending}
          className="self-start px-4"
        >
          {accept.isPending ? "Saving…" : "Accept and continue"}
        </Button>
      </form>
    </section>
  );
}
