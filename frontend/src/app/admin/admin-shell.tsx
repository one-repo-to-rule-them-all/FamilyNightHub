"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { api, type Account, type ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/admin/movies", label: "Movies" },
  { href: "/admin/history", label: "History" },
  { href: "/host", label: "Host" },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="flex flex-wrap items-center gap-2">
      {LINKS.map((link) => {
        const current = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-2 text-base font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
              current ? "bg-muted text-foreground" : "text-muted-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Signed-out → /login; a host (no admin permissions) gets a plain notice. The API enforces
 *  the real check (`admin:*`); this only keeps the screens from rendering half-empty. */
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const me = useQuery<Account, ApiError>({ queryKey: ["me"], queryFn: api.me });
  const signedOut = me.error?.status === 401;

  useEffect(() => {
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  if (me.isPending || signedOut) {
    return (
      <p role="status" className="text-lg text-muted-foreground">
        Loading…
      </p>
    );
  }
  if (me.isError) return <ApiErrorNotice error={me.error} />;
  if (me.data.role !== "admin") {
    return (
      <p role="alert" className="rounded-xl bg-card p-5 text-lg">
        Only a family admin can change the library and past nights.
      </p>
    );
  }
  return <>{children}</>;
}
