import type { Metadata } from "next";

import { BulkAdd } from "./bulk-add";
import { MovieLibrary } from "./movie-library";

export const metadata: Metadata = { title: "Library" };

/** P7 Library (owner-portal.md): flags for the generator, and a bulk add for owned titles
 *  (ADR-0007: the owned library must be seeded before the generator is useful). "Add to
 *  library" is the one primary. Phone: the add form first; desktop: the table with the form
 *  beside it. */
export default function AdminMoviesPage() {
  return (
    <div data-screen="portal-library" className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Library</h1>
        <p className="text-muted-foreground">
          Owned titles, watchlist and blocked movies. Owned titles roll first when you build a
          shortlist; blocked ones never roll.
        </p>
      </header>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-8">
        <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 lg:sticky lg:top-6 lg:order-2">
          <BulkAdd />
        </div>
        <div className="min-w-0 lg:order-1">
          <MovieLibrary />
        </div>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="tmdb-attribution">
        Movie data and posters from TMDB. This product uses the TMDB API but is not endorsed or
        certified by TMDB.
      </p>
    </div>
  );
}
