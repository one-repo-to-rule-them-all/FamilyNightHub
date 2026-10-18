import type { Metadata } from "next";
import { Suspense } from "react";

import { HistoryScreen } from "./history-screen";

export const metadata: Metadata = { title: "History" };

export default function HistoryPage() {
  // useSearchParams (?tab=) needs a Suspense boundary for the static shell.
  return (
    <Suspense>
      <HistoryScreen />
    </Suspense>
  );
}
