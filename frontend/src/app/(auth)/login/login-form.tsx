"use client";

import { useMutation } from "@tanstack/react-query";
import { MailCheck } from "lucide-react";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ApiError, type Schemas } from "@/lib/api";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const send = useMutation<Schemas["MagicLinkOut"], ApiError, string>({
    mutationFn: (address) => api.requestMagicLink({ email: address }),
  });

  if (send.isSuccess) {
    // The server answers the same whether or not the address has an account (no enumeration),
    // so this screen shows its words, not ours.
    return (
      <section
        aria-labelledby="sent-heading"
        className="flex flex-col gap-3 rounded-xl bg-card p-5"
      >
        <MailCheck aria-hidden className="size-8 text-cinema" />
        <h2 id="sent-heading" className="text-xl font-semibold">
          Check your email
        </h2>
        <p className="text-base text-muted-foreground" data-testid="magic-link-sent">
          {send.data.detail}
        </p>
        <Button variant="outline" size="tap" onClick={() => send.reset()}>
          Use a different email
        </Button>
      </section>
    );
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (email.trim() && !send.isPending) send.mutate(email.trim());
      }}
    >
      <div className="flex flex-col gap-3">
        <Label htmlFor="email" className="text-base">
          Email
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-14 text-lg md:text-lg"
        />
      </div>
      <ApiErrorNotice error={send.error} />
      <Button
        type="submit"
        size="tap"
        className="w-full"
        disabled={!email.trim() || send.isPending}
      >
        {send.isPending ? "Sending…" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
