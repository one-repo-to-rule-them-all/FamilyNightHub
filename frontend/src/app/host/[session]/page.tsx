import type { Metadata } from "next";

import { NightBuilder } from "./night-builder";

export const metadata: Metadata = { title: "Tonight" };

/** P6 Run a night (owner-portal.md): inside the portal shell (host layout), not a nav item. */
export default async function HostNightPage({ params }: { params: Promise<{ session: string }> }) {
  const { session } = await params;
  return (
    <div className="mx-auto w-full max-w-2xl lg:mx-0">
      <NightBuilder sessionId={session} />
    </div>
  );
}
