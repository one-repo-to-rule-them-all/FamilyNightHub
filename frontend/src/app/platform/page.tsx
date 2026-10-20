import type { Metadata } from "next";

import { PlatformHome } from "./platform-home";

export const metadata: Metadata = { title: "Platform" };

/** ADR-0016 §8: the operator's own area, never a tab in a family portal. */
export default function PlatformPage() {
  return <PlatformHome />;
}
