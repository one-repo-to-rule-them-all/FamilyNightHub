import type { Metadata } from "next";
import { Suspense } from "react";

import { PersonProfile } from "./person-profile";

export const metadata: Metadata = { title: "Profile" };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // useSearchParams (?from=me) needs a Suspense boundary for the static shell.
  return (
    <Suspense>
      <PersonProfile personId={id} />
    </Suspense>
  );
}
