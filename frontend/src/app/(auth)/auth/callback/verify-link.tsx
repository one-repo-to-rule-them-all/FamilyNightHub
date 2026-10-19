"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Account, type ApiError } from "@/lib/api";
import { linkSpent, passwordProblem } from "@/lib/password";

/**
 * The emailed "forgot password" link (ADR-0014): it sets a new password and signs in, in one
 * step. The link is consumed only on submit, and the server checks the password before it spends
 * the link, so a rejected password can be fixed and sent again. An emailed invite (issue #71) is the
 * same link; `invited` only changes the words.
 */
export function VerifyLink({
  token,
  invited = false,
}: {
  token: string | null;
  invited?: boolean;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const verify = useMutation<Account, ApiError, string>({
    mutationFn: (newPassword) =>
      api.verifyMagicLink({ token: token ?? "", new_password: newPassword }),
    // replace, not push: the spent token must not stay in history.
    onSuccess: () => router.replace("/host"),
  });

  if (!token) {
    return (
      <div className="flex flex-col gap-5">
        <p role="alert" className="text-lg">
          This link is incomplete. Open the link from your email again.
        </p>
        <Link href="/login" className={buttonVariants({ variant: "default", size: "tap" })}>
          Back to sign in
        </Link>
      </div>
    );
  }

  if (verify.isSuccess) {
    return (
      <p aria-live="polite" className="text-lg text-muted-foreground">
        Welcome, {verify.data.display_name}.
      </p>
    );
  }

  // A dead link offers a new one; a weak password (422) can be fixed and resent.
  const spent = linkSpent(verify.error?.status);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        const reason = passwordProblem(password, confirm);
        setProblem(reason);
        if (!reason && !verify.isPending) verify.mutate(password);
      }}
    >
      <div className="flex flex-col gap-3">
        {invited ? (
          <p className="text-base text-muted-foreground">
            You&apos;ve been invited to run family movie nights. Choose a password to finish.
          </p>
        ) : null}
        <Label htmlFor="new-password" className="text-base">
          {invited ? "Choose a password" : "New password"}
        </Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby="new-password-hint"
          className="h-14 text-lg md:text-lg"
        />
        <p id="new-password-hint" className="text-sm text-muted-foreground">
          At least 12 characters. A short sentence works well.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Label htmlFor="confirm-password" className="text-base">
          Type it again
        </Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          className="h-14 text-lg md:text-lg"
        />
      </div>
      {problem ? (
        <p role="alert" className="text-lg">
          {problem}
        </p>
      ) : null}
      <ApiErrorNotice error={verify.error} />
      {spent ? (
        <Link href="/login" className={buttonVariants({ variant: "secondary", size: "tap" })}>
          Send a new link
        </Link>
      ) : null}
      <Button
        type="submit"
        size="tap"
        className="w-full"
        data-testid="primary-action"
        disabled={verify.isPending || spent}
      >
        {verify.isPending ? "Saving…" : "Save and sign in"}
      </Button>
    </form>
  );
}
