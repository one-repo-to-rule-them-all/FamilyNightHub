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
