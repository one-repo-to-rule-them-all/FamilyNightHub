import { Film } from "lucide-react";

import { cn } from "@/lib/utils";

/** TMDB's image CDN; `poster_path` is TMDB's own path ("/abc.jpg"). */
const TMDB_IMAGES = "https://image.tmdb.org/t/p/w342";

/**
 * A 2:3 movie poster. Typed titles (TMDB off, or not on TMDB) have no poster, so they get a
 * title card instead. Decorative: the caller labels the control around it.
 */
export function Poster({
  title,
  posterPath,
  className,
}: {
  title: string;
  posterPath: string | null;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn("relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-muted", className)}
    >
      {posterPath ? (
        // TMDB serves sized posters from its own CDN; Next's optimizer would only proxy them.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${TMDB_IMAGES}${posterPath}`}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-2 bg-gradient-to-b from-secondary to-muted p-3 text-center">
          <Film className="size-8 text-muted-foreground" />
          <span className="text-base leading-tight font-medium text-balance">{title}</span>
        </div>
      )}
    </div>
  );
}
