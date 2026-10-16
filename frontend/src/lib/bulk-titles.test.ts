import { describe, expect, it } from "vitest";

import { MAX_BULK_LINES, parseBulkTitles, parseTitleLine } from "./bulk-titles";

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
