import { CircleAlert } from "lucide-react";

import { type ApiError, retryAfterHint } from "@/lib/api";

/** The server's message as-is (it is already generic), plus the 429 Retry-After hint. */
export function ApiErrorNotice({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const hint = retryAfterHint(error);
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-base"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
      <p>
        <span data-testid="api-error-message">{error.message}</span>
        {hint ? <span className="block text-muted-foreground">{hint}</span> : null}
      </p>
    </div>
  );
}
