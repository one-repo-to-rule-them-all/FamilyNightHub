import type { AlbumPhoto } from "@/lib/photos/album";

/**
 * Slideshow alt text (TV and phone) from who added the photo and when, never the filename
 * (there isn't one, by design).
 */
export function photoAlt(photo: Pick<AlbumPhoto, "person_name" | "taken_on" | "created_at">) {
  return `Photo from ${photo.person_name}, ${photoDate(photo)}`;
}

function photoDate(photo: Pick<AlbumPhoto, "taken_on" | "created_at">): string {
  const format = (date: Date, timeZone?: string) =>
    date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone });
  // taken_on is a calendar date: format it as one, not as midnight UTC shifted into local time.
  return photo.taken_on
    ? format(new Date(`${photo.taken_on}T00:00:00Z`), "UTC")
    : format(new Date(photo.created_at));
}
