import { describe, expect, it } from "vitest";
import { buildFileIndex, fileLineHtml } from "./html.js";

describe("buildFileIndex", () => {
  const lines = [
    "/* start of a comment",
    "  notAnIdentifier(here);",
    "*/",
    "const total = compute(items, 42);",
    "",
  ];
  const index = buildFileIndex([{ side: "after", path: "x.ts", lines, symbols: [] }]);
  const entry = index.get("after:x.ts")!;

  it("bakes an .id span over every identifier into each line's base rendering", () => {
    expect(entry.html[3]).toBe(
      '<span class="tok-kw">const</span> <span class="id">total</span> = <span class="tok-fn id">compute</span>(<span class="id">items</span>, <span class="tok-num">42</span>);',
    );
    expect(entry.html[4]).toBe("");
  });

  it("scans the whole file, so a word inside a multi-line comment is not an identifier", () => {
    expect(entry.html[1]).not.toContain('class="id"');
    expect(entry.ids[1]).toEqual([]);
  });

  it("explains the baked spans only in a debug index", () => {
    expect(entry.html[3]).not.toContain("data-why");
    const debug = buildFileIndex([{ side: "after", path: "x.ts", lines, symbols: [] }], { debug: true });
    expect(debug.get("after:x.ts")!.html[3]).toContain('<span class="id" data-why="id · not asked yet">total</span>');
  });
});

describe("fileLineHtml", () => {
  const lines = ["const total = compute(items, 42);"];
  const entry = buildFileIndex([{ side: "after", path: "x.ts", lines, symbols: [] }]).get("after:x.ts")!;

  it("is the base rendering when nothing is marked", () => {
    expect(fileLineHtml(entry, 1)).toBe(entry.html[0]);
  });

  it("layers a pane's marks in, and an identifier a mark covers keeps the mark's span alone", () => {
    const html = fileLineHtml(entry, 1, [{ start: 14, end: 21, cls: "csite", attrs: 'data-target="t"' }]);
    expect(html).toContain('<span class="tok-fn csite" data-target="t">compute</span>');
    expect(html).not.toContain('id">compute');
    expect(html).toContain('<span class="id">items</span>');
  });

  it("renders a line the file does not have as nothing, like the expander", () => {
    expect(fileLineHtml(entry, 0)).toBe("");
    expect(fileLineHtml(entry, 2)).toBe("");
  });
});
