"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { type Account, type ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/admin/people", label: "People" },
  { href: "/admin/devices", label: "Devices" },
  { href: "/admin/settings", label: "Settings" },
] as const;

/** Header + People/Devices/Settings nav around every admin screen. Wider than the phone column. */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const me = useQuery<Account, ApiError>({ queryKey: ["me"], queryFn: api.me });
  const signedOut = me.error?.status === 401;

  useEffect(() => {
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Admin</h1>
          <Link
            href="/host"
            className="rounded-md text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Back to host
          </Link>
        </div>
        {me.data ? (
          <p className="text-sm text-muted-foreground" data-testid="admin-signed-in-as">
            {me.data.display_name} ({me.data.role}) · {me.data.household_name}
          </p>
        ) : null}
        <nav aria-label="Admin">
          <ul className="flex gap-1 rounded-xl bg-card p-1 ring-1 ring-foreground/10">
            {NAV.map((item) => {
              const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href} className="flex-1">
                  <Link
                    href={item.href}
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "flex h-11 items-center justify-center rounded-lg px-3 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      current
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main className="flex flex-col gap-6">{children}</main>
    </div>
  );
}
