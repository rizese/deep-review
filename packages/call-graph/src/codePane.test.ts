import { describe, expect, it } from "vitest";
import { renderCodePane, SCOPE_CARET } from "./codePane.js";
import type { DiffRow } from "./diffView.js";
import { CSS } from "./html.js";

const rows: DiffRow[] = [
  { kind: "ctx", n: 1, text: "# Title" },
  { kind: "ctx", n: 2, text: "Body." },
];

describe("renderCodePane", () => {
  it("wraps markdown panes, with the gutter width available for the hanging indent", () => {
    const html = renderCodePane({ file: "docs/notes.md", entry: undefined, rows, lang: "ts" });
    expect(html).toContain('<pre class="source wrap" data-w="1" style="--gutter:1">');
  });

  it("does not wrap non-markdown panes, so code keeps its horizontal scroll", () => {
    const html = renderCodePane({ file: "src/index.ts", entry: undefined, rows, lang: "ts" });
    expect(html).toContain('<pre class="source" data-w="1">');
    expect(html).not.toContain("wrap");
  });
});

describe("scope bar folding", () => {
  it("leads every bar with a caret and marks it open, so a click can fold the pane by transition", () => {
    const html = renderCodePane({ file: "x.ts", entry: undefined, rows, lang: "ts" });
    expect(html).toContain(`<div class="scope-bar" aria-expanded="true">${SCOPE_CARET}`);
    // Folding is one max-height transition, run forwards and back, not display: none.
    expect(CSS).toContain("max-height: var(--pane-h, none);");
    expect(CSS).toMatch(/\.code-pane\.collapsed > pre\.source \{\s*max-height: 0; padding-top: 0; padding-bottom: 0; border-top-width: 0; border-bottom-width: 0; overflow: hidden;/);
    // One radius for the pane: 8px like the panels, all round once folded.
    expect(CSS).toContain("border-radius: 8px 8px 0 0;");
    expect(CSS).toContain(".code-pane.collapsed .scope-bar { border-bottom-color: var(--line-c); border-radius: 8px; }");
    expect(CSS).toContain(".code-pane.collapsed .scope-caret svg { transform: rotate(-90deg); }");
  });
});
