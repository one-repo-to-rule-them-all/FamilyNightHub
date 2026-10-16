"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { buttonVariants } from "@/components/ui/button";
import { api, type Account, type ApiError } from "@/lib/api";

export function VerifyLink({ token }: { token: string | null }) {
  const router = useRouter();
  const started = useRef(false);
  const verify = useMutation<Account, ApiError, string>({
    mutationFn: (value) => api.verifyMagicLink({ token: value }),
    // replace, not push: the spent token must not stay in history.
    onSuccess: () => router.replace("/host"),
  });
  const { mutate } = verify;

  useEffect(() => {
    // Links are single-use: StrictMode's double effect must not spend it twice.
    if (!token || started.current) return;
    started.current = true;
    mutate(token);
  }, [token, mutate]);

  // A mangled token fails schema validation (422) before the server can call it expired; to the
  // person holding the link that is the same thing as an incomplete link.
  const malformed = verify.error?.code === "validation_error";

  if (!token || verify.isError) {
    return (
      <div className="flex flex-col gap-5">
        {verify.error && !malformed ? (
          <ApiErrorNotice error={verify.error} />
        ) : (
          <p role="alert" className="text-lg">
            This sign-in link is incomplete. Open the link from your email again.
          </p>
        )}
        <Link href="/login" className={buttonVariants({ variant: "default", size: "tap" })}>
          Send a new link
        </Link>
      </div>
    );
  }

  return (
    <p aria-live="polite" className="text-lg text-muted-foreground">
      {verify.isSuccess ? `Welcome, ${verify.data.display_name}.` : "Checking your link…"}
    </p>
  );
}
