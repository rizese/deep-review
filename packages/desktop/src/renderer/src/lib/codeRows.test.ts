import { describe, expect, it } from "vitest";
import { buildFileIndex, gapRow, type Decorations } from "../../../../../call-graph/src/html.js";
import { fileDiffRows, renderDiffRows, type DiffRow } from "../../../../../call-graph/src/diffView.js";
import { languageOf } from "../../../../../call-graph/src/highlight.js";
import type { DiffHunk } from "../../../../../call-graph/src/types.js";
import { buildPaneRows } from "./codeRows.js";
import type { FileEntry } from "./callGraph.js";

/**
 * The pane's rows are React's, but every byte inside one still comes from
 * the analysis package's renderers — so the pieces this module builds must
 * join back up into exactly the string `renderDiffRows` produces. That is
 * what keeps the client app's code panes identical to the server's.
 */
function joined(rows: readonly DiffRow[], options: Parameters<typeof buildPaneRows>[1]): string {
  return buildPaneRows(rows, options)
    .map((row) =>
      row.kind === "line"
        ? `<span class="${row.cls}">${row.html}</span>`
        : options.entry
          ? gapRow(options.entry, row.from, row.to)
          : `<div class="gap static"><span class="gap-count">⋯ ${row.to - row.from + 1} hidden lines</span></div>`,
    )
    .join("");
}

const lines = [
  "export const LIMIT = 3;",
  "",
  "/** Adds the configured limit to a count. */",
  "export function helper(n: number): number {",
  "  return n + LIMIT;",
  "}",
  "",
  ...Array.from({ length: 40 }, (_, i) => `const filler${i} = ${i};`),
  "export function tail(): void {}",
];

const hunks: DiffHunk[] = [
  {
    header: "@@ -4,2 +4,2 @@",
    oldStart: 4,
    oldLines: 2,
    newStart: 4,
    newLines: 2,
    lines: ["-export function helper(n: number) {", "+export function helper(n: number): number {", "   return n + LIMIT;"],
  },
];

function entryFor(): FileEntry {
  const index = buildFileIndex([{ side: "after", path: "lib.ts", lines, symbols: [{ name: "helper", kind: "function", startLine: 4, endLine: 6 }] }]);
  return index.get("after:lib.ts")!;
}

describe("pane rows", () => {
  const lang = languageOf("lib.ts");

  it("rebuild exactly what renderDiffRows writes, gaps and all", () => {
    const entry = entryFor();
    const rows = fileDiffRows(entry.lines, hunks, { context: 3 });
    const options = { width: 2, lang, entry };
    expect(rows.some((r) => r.kind === "gap")).toBe(true);
    expect(joined(rows, options)).toBe(renderDiffRows(rows, options));
  });

  it("rebuild a pane with marks, a focus stripe and pinned lines", () => {
    const entry = entryFor();
    const decorations: Decorations = new Map([
      [5, { cls: ["hl"], marks: [{ start: 9, end: 14, cls: "csite", attrs: 'data-target="x"' }] }],
      [47, { marks: [{ start: 0, end: 5, cls: "self-sym" }] }],
    ]);
    const rows = fileDiffRows(entry.lines, hunks, { context: 2, focus: { startLine: 4, endLine: 6 } });
    const options = { width: 2, lang, entry, decorations, focus: { startLine: 4, endLine: 6 } };
    expect(joined(rows, options)).toBe(renderDiffRows(rows, options));
  });

  it("rebuild a pane whose file the page does not embed", () => {
    const rows: DiffRow[] = [
      { kind: "gap", from: 1, to: 9 },
      { kind: "ctx", n: 10, text: "function f() {" },
      { kind: "del", text: "  return 1;" },
      { kind: "add", n: 11, text: "  return 2;" },
      { kind: "meta", text: "\\ No newline at end of file" },
    ];
    const options = { width: 3, lang, debug: true };
    expect(joined(rows, options)).toBe(renderDiffRows(rows, options));
  });
});
