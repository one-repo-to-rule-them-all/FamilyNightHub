import { ShieldAlert } from "lucide-react";
import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import type { ApiError } from "@/lib/api";

/**
 * A failed admin query. The API is the boundary: a host (no `admin:*` permission) gets 403, shown
 * as an explanation rather than the raw message. Anything else is the server's message as-is.
 */
export function AdminQueryError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  if (error.status !== 403) return <ApiErrorNotice error={error} />;
  return (
    <div
      role="alert"
      data-testid="admin-forbidden"
      className="flex gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
    >
      <ShieldAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-2">
        <p className="text-lg font-medium">Admins only</p>
        <p className="text-muted-foreground">
          Your account can run nights but can&apos;t change the household&apos;s people, devices,
          movies, past nights or settings. Ask an admin if something here needs changing.
        </p>
        <Link
          href="/host"
          className="w-fit rounded-md text-sm underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Back to host
        </Link>
      </div>
    </div>
  );
}
