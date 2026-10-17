import type { Metadata } from "next";

import { HostHome } from "./host-home";

export const metadata: Metadata = { title: "Home" };

/** Home: Up next, Needs you, At a glance (proposals/owner-portal.md §5 P1). */
export default function HostPage() {
  return (
    <>
      <h1 className="sr-only">Home</h1>
      <HostHome />
    </>
  );
}
