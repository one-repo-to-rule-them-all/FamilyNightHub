/**
 * The bulk-add textarea on /admin/movies: one title per line, optional "(year)" at the end
 * (ADR-0007: the owned library is seeded by hand). The server resolves each line on TMDB.
 */

export const MAX_BULK_LINES = 100;
const MIN_YEAR = 1870;
const MAX_YEAR = 2100;
const MAX_TITLE = 300;

export type ParsedTitle = { title: string; year: number | null };

export type ParsedBulk = {
  titles: ParsedTitle[];
  /** Lines over MAX_BULK_LINES, left for a second paste. */
  overflow: number;
};

const YEAR_SUFFIX = /^(.*?)\s*\((\d{4})\)$/;

/** "Paddington 2 (2017)" → { title: "Paddington 2", year: 2017 }; blank lines are skipped. */
export function parseTitleLine(line: string): ParsedTitle | null {
  const clean = line.split(/\s+/).filter(Boolean).join(" ");
  if (!clean) return null;
  const match = YEAR_SUFFIX.exec(clean);
  if (match && match[1]) {
    const year = Number(match[2]);
    if (year >= MIN_YEAR && year <= MAX_YEAR) {
      return { title: match[1].slice(0, MAX_TITLE), year };
    }
  }
  return { title: clean.slice(0, MAX_TITLE), year: null };
}

/** Every non-blank line, duplicates (same title and year, any case) dropped. */
export function parseBulkTitles(text: string): ParsedBulk {
  const seen = new Set<string>();
  const titles: ParsedTitle[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseTitleLine(line);
    if (!parsed) continue;
    const key = `${parsed.title.toLowerCase()}|${parsed.year ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(parsed);
  }
  return {
    titles: titles.slice(0, MAX_BULK_LINES),
    overflow: Math.max(0, titles.length - MAX_BULK_LINES),
  };
}

/** What the summary needs from a server `BulkLineOut`. */
export type AddedLine = {
  title: string;
  year: number | null;
  status: "matched" | "ambiguous" | "not_found" | "added_manual";
  already_owned: boolean;
  movie: { title: string; year: number | null } | null;
};

function titled(line: AddedLine): string {
  const found = line.status === "matched" && line.movie ? line.movie : line;
  return found.year ? `${found.title} (${found.year})` : found.title;
}

/**
 * The confirmation after an add (issue #92): one line names the title ("Added Coco to the
 * library", "Coco is already in the library"); a paste counts ("Added 3, skipped 1"). `isOpen`
 * says which ambiguous / not-found lines still wait for the admin's choice.
 */
export function addSummary(
  lines: readonly AddedLine[],
  isOpen: (index: number) => boolean,
): string {
  let added = 0;
  let owned = 0;
  let skipped = 0;
  let waiting = 0;
  lines.forEach((line, index) => {
    if (line.status === "added_manual" || (line.status === "matched" && !line.already_owned)) {
      added += 1;
    } else if (line.status === "matched") owned += 1;
    else if (isOpen(index)) waiting += 1;
    else skipped += 1;
  });
  const choose =
    waiting === 1 ? "1 title needs a choice below." : `${waiting} titles need a choice below.`;

  if (lines.length === 1) {
    const name = titled(lines[0]!);
    if (added) return `Added ${name} to the library.`;
    if (owned) return `${name} is already in the library.`;
    if (waiting) return `Pick which ${name} you meant below.`;
    return `${name} was not added.`;
  }
  const counts = [`Added ${added}`, `skipped ${owned + skipped}`].join(", ");
  const why = owned ? ` (${owned} already in the library)` : "";
  return `${counts}${why}.${waiting ? ` ${choose}` : ""}`;
}
