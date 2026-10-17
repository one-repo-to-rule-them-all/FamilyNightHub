import type { Metadata } from "next";

import { HistoryAdmin } from "./history-admin";

export const metadata: Metadata = { title: "History" };

/** P7 History (owner-portal.md): past nights for both roles; the winner correction (ADR-0006:
 *  the vote's ranking is kept as cast; the correction is a re-close with an audit row) is
 *  `admin:history`, so hosts get the same table without it. */
export default function AdminHistoryPage() {
  return <HistoryAdmin />;
}
