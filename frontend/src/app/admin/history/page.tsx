import type { Metadata } from "next";

import { HistoryAdmin } from "./history-admin";

export const metadata: Metadata = { title: "History" };

/** Past nights, with a winner correction (ADR-0006: the vote's ranking is kept as cast;
 *  the correction is a re-close with an audit row). */
export default function AdminHistoryPage() {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground">
        Watched something other than the winner? Correct it here. The vote itself is kept.
      </p>
      <HistoryAdmin />
    </div>
  );
}
