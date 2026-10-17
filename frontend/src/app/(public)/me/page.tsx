import type { Metadata } from "next";
import { Suspense } from "react";

import { MyProfile } from "./my-profile";

export const metadata: Metadata = { title: "My profile" };

export default function MePage() {
  // useSearchParams (?rename=1) needs a Suspense boundary for the static shell.
  return (
    <Suspense>
      <MyProfile />
    </Suspense>
  );
}
