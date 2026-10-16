"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError } from "@/lib/api";

/** TanStack Query owns server state (04-frontend.md "State management"). */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A 4xx answer will not change on retry; only transient failures are retried.
            retry: (failures, error) =>
              failures < 2 &&
              !(error instanceof ApiError && error.status >= 400 && error.status < 500),
            refetchOnWindowFocus: true,
            staleTime: 5_000,
          },
          mutations: { retry: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
