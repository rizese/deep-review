/**
 * Turning a span in a rendered pane into a position the navigation server
 * understands, and back again. A port of the DOM half of EXPLORER_NAV_JS:
 * `columnOf`, `positionOf`, `spanAt` and `resolveSpan`.
 */
import { definitionAt, defNames } from "./nav.js";
import type { DefinitionAnswer } from "./callGraph.js";

export interface SpanPosition {
  file: string;
  side: string;
  line: number;
  column: number;
}

/** Column of a span within its row's text: everything between the gutter and it. */
export function columnOf(row: Element, span: Element): number {
  const lineno = row.querySelector(".lineno");
  if (!lineno) return -1;
  const range = document.createRange();
  range.setStartAfter(lineno);
  range.setEndBefore(span);
  return range.toString().length;
}

/** Where an identifier sits in the file its pane shows. */
export function positionOf(span: Element): SpanPosition | null {
  const pane = span.closest(".code-pane") as HTMLElement | null;
  const row = span.closest(".line");
  if (!pane || !row || !pane.dataset.file) return null;
  const lineno = row.querySelector(".lineno");
  const line = lineno ? parseInt(lineno.textContent ?? "", 10) : NaN;
  if (!(line > 0)) return null;
  return { file: pane.dataset.file, side: pane.dataset.side ?? "after", line, column: columnOf(row, span) };
}

/** The span at a line and column of a pane showing `file`, if it is rendered. */
export function spanAt(scope: Element, file: string, line: number, column: number): HTMLElement | null {
  for (const pane of scope.querySelectorAll<HTMLElement>(".code-pane")) {
    if (pane.dataset.file !== file) continue;
    for (const row of pane.querySelectorAll(".line")) {
      const lineno = row.querySelector(".lineno");
      if (!lineno || parseInt(lineno.textContent ?? "", 10) !== line) continue;
      for (const span of row.querySelectorAll<HTMLElement>(".id, .self-sym, .csite, .sym")) {
        if (columnOf(row, span) === column) return span;
      }
      return null;
    }
  }
  return null;
}

/**
 * What the server says a span is, asked once and remembered on the span
 * itself. Null for a miss, for a before-side pane the head checkout cannot
 * answer for, or with no server.
 */
export async function resolveSpan(base: string, span: HTMLElement, debug: boolean): Promise<DefinitionAnswer | null> {
  if ("nav" in span.dataset) return span.dataset.nav ? (JSON.parse(span.dataset.nav) as DefinitionAnswer) : null;
  const at = positionOf(span);
  if (!at || at.side !== "after") return null;
  const { ok, answer, why } = await definitionAt(base, at);
  // A hiccup is not an answer: leave the span unresolved so the next click retries.
  if (!ok) return null;
  span.dataset.nav = answer ? JSON.stringify(answer) : "";
  if (answer) {
    span.classList.add("sym");
    span.dataset.def = answer.id;
    if (!answer.self) span.dataset.target = answer.panelId;
    defNames.set(answer.panelId, answer.name);
    if (debug) {
      span.dataset.why =
        `sym · ${answer.name} (${answer.kind}) ${answer.id} in ${answer.decl.file}` +
        (answer.self ? " · this is the declaration" : ` · opens ${answer.panelId}`);
    }
  } else {
    span.classList.add("miss");
    setTimeout(() => span.classList.remove("miss"), 900);
    if (debug) span.dataset.why = `unresolved · ${why}`;
  }
  return answer;
}
