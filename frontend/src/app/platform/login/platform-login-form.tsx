"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ApiError, type PlatformMe, retryAfterHint, type Schemas } from "@/lib/api";

/**
 * ADR-0016 §2: the operator's own sign-in. A family session never counts, so the password is
 * asked again. Wrong credentials and "not an operator" get the same answer.
 */
export function PlatformLoginForm() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation<PlatformMe, ApiError, Schemas["PlatformLoginIn"]>({
    mutationFn: api.platformLogin,
    onSuccess: () => router.replace("/platform"),
    onError: () => setPassword(""),
  });
  const wait = login.error ? retryAfterHint(login.error) : null;
  const ready = identifier.trim() !== "" && password !== "";

  return (
    <form
      className="flex flex-col gap-5"
      data-screen="platform-login"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !login.isPending) {
          login.mutate({ username_or_email: identifier.trim(), password });
        }
      }}
    >
      <div className="flex flex-col gap-3">
        <Label htmlFor="platform-identifier" className="text-base">
          Username or email
        </Label>
        <Input
          id="platform-identifier"
          required
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          className="h-14 text-lg md:text-lg"
        />
      </div>
      <div className="flex flex-col gap-3">
        <Label htmlFor="platform-password" className="text-base">
          Password
        </Label>
        <Input
          id="platform-password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-14 text-lg md:text-lg"
        />
      </div>
      <ApiErrorNotice error={login.error} />
      {wait ? <p className="text-sm text-muted-foreground">{wait}</p> : null}
      <Button type="submit" size="lg" disabled={!ready || login.isPending} className="h-14 text-lg">
        {login.isPending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
