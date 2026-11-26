import { Suspense } from "react";

import { TvReel } from "./tv-reel";

export default function TvReelPage() {
  // useSearchParams (?window=) needs a Suspense boundary for the static shell, or the
  // production build fails to prerender this page (dev mode does not check).
  return (
    <Suspense>
      <TvReel />
    </Suspense>
  );
}
