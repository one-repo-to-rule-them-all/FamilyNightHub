"use client";

import { useMutation } from "@tanstack/react-query";
import { MailCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Account, type ApiError, retryAfterHint, type Schemas } from "@/lib/api";

/**
 * Admin and host sign-in (ADR-0014): username or email, plus password. Every failure gets the
 * same answer from the server (no enumeration), so this shows its message as-is. "Forgot
 * password?" emails a link that sets a new one.
 */
export function LoginForm() {
  const [forgot, setForgot] = useState(false);
  return forgot ? (
    <ForgotPassword onBack={() => setForgot(false)} />
  ) : (
    <PasswordLogin onForgot={() => setForgot(true)} />
  );
}

function PasswordLogin({ onForgot }: { onForgot: () => void }) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation<Account, ApiError, Schemas["LoginIn"]>({
    mutationFn: api.login,
    onSuccess: () => router.replace("/host"),
    onError: () => setPassword(""),
  });
  const wait = login.error ? retryAfterHint(login.error) : null;
  const ready = identifier.trim() !== "" && password !== "";

  return (
    <form
      className="flex flex-col gap-5"
      data-screen="admin-login"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !login.isPending) {
          login.mutate({ username_or_email: identifier.trim(), password });
        }
      }}
    >
      <div className="flex flex-col gap-3">
        <Label htmlFor="identifier" className="text-base">
          Username or email
        </Label>
        <Input
          id="identifier"
          name="username"
          required
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          className="h-14 text-lg md:text-lg"
        />
      </div>
      <div className="flex flex-col gap-3">
        <Label htmlFor="password" className="text-base">
          Password
        </Label>
        <Input
          id="password"
          name="password"
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
      <Button
        type="submit"
        size="tap"
        className="w-full"
        data-testid="primary-action"
        disabled={!ready || login.isPending}
      >
        {login.isPending ? "Signing in…" : "Sign in"}
      </Button>
      <Button type="button" variant="link" size="tap" onClick={onForgot}>
        Forgot password?
      </Button>
    </form>
  );
}

function ForgotPassword({ onBack }: { onBack: () => void }) {
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
        <Button variant="secondary" size="tap" onClick={onBack}>
          Back to sign in
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
      <p className="text-lg text-muted-foreground">
        We&apos;ll email you a link to choose a new password.
      </p>
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
        {send.isPending ? "Sending…" : "Email me a reset link"}
      </Button>
      <Button type="button" variant="ghost" size="tap" onClick={onBack}>
        Back to sign in
      </Button>
    </form>
  );
}
