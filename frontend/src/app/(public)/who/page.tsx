import type { Metadata } from "next";

import { WhoGrid } from "./who-grid";

export const metadata: Metadata = { title: "Who's watching?" };

export default function WhoPage() {
  return <WhoGrid />;
}
