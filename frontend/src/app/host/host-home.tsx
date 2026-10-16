"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { api, type Account, type ApiError } from "@/lib/api";

export function HostHome() {
  const router = useRouter();
  const me = useQuery<Account, ApiError>({ queryKey: ["me"], queryFn: api.me });
  const logout = useMutation<void, ApiError>({
    mutationFn: api.logout,
    onSuccess: () => router.replace("/login"),
  });
  const signedOut = me.error?.status === 401;

  useEffect(() => {
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  if (me.isPending || signedOut) {
    return <p className="text-lg text-muted-foreground">Loading…</p>;
  }
  if (me.isError) return <ApiErrorNotice error={me.error} />;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-lg" data-testid="signed-in-as">
        Signed in as <strong>{me.data.display_name}</strong> ({me.data.role}) for{" "}
        {me.data.household_name}.
      </p>
      <p className="text-muted-foreground">
        Shortlists, voting and device approvals arrive here next.
      </p>
      <ApiErrorNotice error={logout.error} />
      <Button
        variant="outline"
        size="tap"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
      >
        Sign out
      </Button>
    </div>
  );
}
