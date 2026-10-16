"use client";

import { Film } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

/** TMDB's image CDN (public, no token). The API only ever hands us `poster_path`. */
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";

export function posterUrl(posterPath: string | null, width: "w185" | "w342" | "w500" = "w342") {
  return posterPath ? `${TMDB_IMAGE_BASE}${width}${posterPath}` : null;
}

/**
 * A 2:3 poster, or a title card when there is no poster (typed titles, TMDB off) or the image
 * fails to load. Decorative: the title is always rendered as text next to it by the caller.
 */
export function Poster({
  title,
  posterPath,
  width = "w342",
  label = true,
  className,
}: {
  title: string;
  posterPath: string | null;
  width?: "w185" | "w342" | "w500";
  /** Print the title on the fallback card; off for thumbnails too small to read it. */
  label?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = posterUrl(posterPath, width);
  return (
    <div
      aria-hidden
      className={cn(
        "relative aspect-[2/3] overflow-hidden rounded-lg bg-muted ring-1 ring-foreground/10",
        className,
      )}
    >
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- TMDB CDN, sized by the URL itself
        <img
          src={src}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-2 text-center">
          <Film className="size-1/4 text-muted-foreground" />
          {label ? (
            <span className="line-clamp-3 text-[0.7em] leading-tight text-muted-foreground">
              {title}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
