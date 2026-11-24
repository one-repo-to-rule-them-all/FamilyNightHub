import { describe, expect, it } from "vitest";

import {
  addSummary,
  type AddedLine,
  MAX_BULK_LINES,
  parseBulkTitles,
  parseTitleLine,
} from "./bulk-titles";

describe("parseTitleLine", () => {
  it("reads a trailing year", () => {
    expect(parseTitleLine("  Paddington 2   (2017) ")).toEqual({
      title: "Paddington 2",
      year: 2017,
    });
  });

  it("keeps a title without a year", () => {
    expect(parseTitleLine("Toy   Story")).toEqual({ title: "Toy Story", year: null });
  });

  it("treats an out-of-range year as part of the title", () => {
    expect(parseTitleLine("Rocket (1234)")).toEqual({ title: "Rocket (1234)", year: null });
  });

  it("does not treat a lone year as a title with a year", () => {
    expect(parseTitleLine("(1999)")).toEqual({ title: "(1999)", year: null });
    expect(parseTitleLine("1917")).toEqual({ title: "1917", year: null });
  });

  it("skips blank lines and caps very long titles", () => {
    expect(parseTitleLine("   ")).toBeNull();
    expect(parseTitleLine("x".repeat(400))?.title).toHaveLength(300);
  });
});

describe("parseBulkTitles", () => {
  it("parses every line, dropping blanks and duplicates", () => {
    const parsed = parseBulkTitles("Coco\r\n\ncoco\nCoco (2017)\n Up \n");
    expect(parsed).toEqual({
      titles: [
        { title: "Coco", year: null },
        { title: "Coco", year: 2017 },
        { title: "Up", year: null },
      ],
      overflow: 0,
    });
  });

  it("caps a paste at the server's limit and reports the rest", () => {
    const text = Array.from({ length: MAX_BULK_LINES + 3 }, (_, i) => `Movie ${i}`).join("\n");
    const parsed = parseBulkTitles(text);
    expect(parsed.titles).toHaveLength(MAX_BULK_LINES);
    expect(parsed.overflow).toBe(3);
  });
});

describe("addSummary", () => {
  const line = (over: Partial<AddedLine>): AddedLine => ({
    title: "Coco",
    year: null,
    status: "matched",
    already_owned: false,
    movie: { title: "Coco", year: 2017 },
    ...over,
  });
  const never = () => false;

  it("names a single added title, with TMDB's year", () => {
    expect(addSummary([line({})], never)).toBe("Added Coco (2017) to the library.");
    expect(addSummary([line({ status: "added_manual", movie: null })], never)).toBe(
      "Added Coco to the library.",
    );
  });

  it("says when a single title was already there", () => {
    expect(addSummary([line({ already_owned: true })], never)).toBe(
      "Coco (2017) is already in the library.",
    );
  });

  it("asks for a choice, or says it was skipped", () => {
    const open = line({ status: "ambiguous", movie: null });
    expect(addSummary([open], () => true)).toBe("Pick which Coco you meant below.");
    expect(addSummary([open], never)).toBe("Coco was not added.");
  });

  it("counts a paste", () => {
    const lines = [
      line({}),
      line({ status: "added_manual", movie: null }),
      line({ already_owned: true }),
      line({ status: "not_found", movie: null }),
      line({ status: "ambiguous", movie: null }),
    ];
    expect(addSummary(lines, (i) => i === 4)).toBe(
      "Added 2, skipped 2 (1 already in the library). 1 title needs a choice below.",
    );
    expect(addSummary(lines.slice(0, 2), never)).toBe("Added 2, skipped 0.");
  });
});
