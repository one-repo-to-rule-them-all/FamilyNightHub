import type { Metadata } from "next";

import { HistoryAdmin } from "./history-admin";

export const metadata: Metadata = { title: "History" };

/** Past nights, with a winner correction (ADR-0006: the vote's ranking is kept as cast;
 *  the correction is a re-close with an audit row). */
export default function AdminHistoryPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">History</h1>
        <p className="text-lg text-muted-foreground">
          Watched something other than the winner? Correct it here. The vote itself is kept.
        </p>
      </header>
      <HistoryAdmin />
    </div>
  );
}
