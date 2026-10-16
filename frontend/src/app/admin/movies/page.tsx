import type { Metadata } from "next";

import { BulkAdd } from "./bulk-add";
import { MovieLibrary } from "./movie-library";

export const metadata: Metadata = { title: "Movies" };

/** The household's library: flags for the generator, and a bulk add for owned titles
 *  (ADR-0007: the owned library must be seeded before the generator is useful). */
export default function AdminMoviesPage() {
  return (
    <div className="flex flex-col gap-10">
      <p className="text-muted-foreground">
        Owned titles roll first in the candidate generator; blocked titles never roll.
      </p>
      <BulkAdd />
      <MovieLibrary />
      <p className="text-xs text-muted-foreground" data-testid="tmdb-attribution">
        Movie data and posters from TMDB. This product uses the TMDB API but is not endorsed or
        certified by TMDB.
      </p>
    </div>
  );
}
