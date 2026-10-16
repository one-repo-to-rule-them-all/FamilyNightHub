"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ApiError, type JoinResult } from "@/lib/api";
import { cleanNightCodeInput, completeNightCode, lookalikes } from "@/lib/night-code";

export function JoinForm({ slug }: { slug: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const join = useMutation<JoinResult, ApiError, string>({
    mutationFn: (nightCode) => api.join({ slug, night_code: nightCode }),
    onSuccess: () => router.push("/who"),
  });

  const ready = completeNightCode(code);
  const misread = lookalikes(code);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !join.isPending) join.mutate(ready);
      }}
    >
      <div className="flex flex-col gap-3">
        <Label htmlFor="night-code" className="text-base">
          Night code
        </Label>
        <Input
          id="night-code"
          name="night-code"
          value={code}
          onChange={(event) => setCode(cleanNightCodeInput(event.target.value))}
          placeholder="ABC234"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="go"
          aria-describedby="night-code-hint"
          aria-invalid={misread.length > 0 || undefined}
          className="h-16 text-center font-mono text-3xl tracking-[0.35em] uppercase md:text-3xl"
        />
        <p id="night-code-hint" className="text-sm text-muted-foreground">
          {misread.length > 0
            ? `Night codes never use ${misread.join(", ")}. Check the TV again.`
            : "Six letters and numbers. Spaces and dashes are fine."}
        </p>
      </div>
      <ApiErrorNotice error={join.error} />
      <Button type="submit" size="tap" className="w-full" disabled={!ready || join.isPending}>
        {join.isPending ? "Joining…" : "Join"}
      </Button>
    </form>
  );
}
