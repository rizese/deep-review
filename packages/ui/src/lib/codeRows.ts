/**
 * Diff rows turned into the pieces a code pane renders. The structure —
 * which rows, in what order, with which classes — is the component's; the
 * content of a line is still the analysis package's own `renderLine` /
 * `fileLineHtml` output, so highlighting, identifier spans and marks are
 * byte-for-byte what the server-rendered page shows.
 *
 * A port of the row half of `renderDiffRows` in `diffView.ts`.
 */
import {
  escapeHtml as esc,
  fileLineHtml,
  identifierMarks,
  identifiersOf,
  renderLine,
  tokenizeLines,
} from "./callGraph.js";
import type { Decorations, DiffRow, FileEntry, Language, LineSpan, Mark } from "./callGraph.js";

/** Lines revealed per click of an expander, matching GitHub — and `EXPAND_STEP`. */
export const EXPAND_STEP = 20;

export type PaneRow =
  | { kind: "line"; key: string; cls: string; html: string }
  | { kind: "gap"; key: string; from: number; to: number };

export interface PaneRowOptions {
  width: number;
  lang: Language;
  entry?: FileEntry | undefined;
  decorations?: Decorations | undefined;
  focus?: LineSpan | undefined;
  debug?: boolean | undefined;
}

/** `<span class="lineno">…</span>` plus the line's own HTML — what `lineRow` puts inside a row. */
function rowInner(lineNumber: number | string, width: number, contentHtml: string): string {
  return `<span class="lineno">${String(lineNumber).padStart(width)}</span>${contentHtml}`;
}

/**
 * Cut every gap around the lines `pinned` says must show, which become
 * context rows of the file's own text. Gaps that end up empty vanish.
 */
function pinRows(rows: readonly DiffRow[], entry: FileEntry, pinned: (n: number) => boolean): DiffRow[] {
  const out: DiffRow[] = [];
  for (const row of rows) {
    if (row.kind !== "gap") {
      out.push(row);
      continue;
    }
    let from = row.from;
    for (let n = row.from; n <= row.to; n++) {
      if (!pinned(n)) continue;
      if (n > from) out.push({ kind: "gap", from, to: n - 1 });
      out.push({ kind: "ctx", n, text: entry.lines[n - 1] ?? "" });
      from = n + 1;
    }
    if (from <= row.to) out.push({ kind: "gap", from, to: row.to });
  }
  return out;
}

/**
 * One line of an embedded file as the expander reveals it: the file's own
 * base rendering, no decoration — the same string `the page's former gap script` inserts.
 */
export function revealedRow(entry: FileEntry, n: number, width: number): Extract<PaneRow, { kind: "line" }> {
  return { kind: "line", key: `r${n}`, cls: "line", html: rowInner(n, width, fileLineHtml(entry, n)) };
}

export function buildPaneRows(input: readonly DiffRow[], options: PaneRowOptions): PaneRow[] {
  const { width, lang, entry, decorations, focus } = options;
  const debug = options.debug ?? false;
  // A decorated or focused line is one the reader is meant to see, so it is
  // never left inside a gap for the expander to reveal as a plain base row.
  const pinned = (n: number): boolean =>
    Boolean(decorations?.has(n)) || (focus !== undefined && n >= focus.startLine && n <= focus.endLine);
  const rows = entry ? pinRows(input, entry, pinned) : input;
  // Rows without an embedded file are tokenized together so multi-line
  // strings and comments carry across them.
  const texts = rows.map((r) => (r.kind === "ctx" || r.kind === "add" || r.kind === "del" ? r.text : ""));
  const localTokens = tokenizeLines(texts, lang);
  const localIds = identifiersOf(texts, lang);
  return rows.map((row, i): PaneRow => {
    switch (row.kind) {
      case "gap":
        return { kind: "gap", key: `g${i}:${row.from}-${row.to}`, from: row.from, to: row.to };
      case "meta":
        return { kind: "line", key: `m${i}`, cls: "line", html: rowInner("", width, esc(row.text)) };
      case "del":
        return {
          kind: "line",
          key: `d${i}`,
          cls: "line diff-del",
          html: rowInner("−", width, renderLine(row.text, localTokens[i]!, row.marks ?? [])),
        };
      default: {
        const deco = decorations?.get(row.n);
        const marks: Mark[] = [...(row.kind === "add" ? (row.marks ?? []) : []), ...(deco?.marks ?? [])];
        // The embedded file backs this row only when it is this row's text;
        // a row from a stale hunk falls back to its own tokens.
        const html =
          entry && entry.lines[row.n - 1] === row.text
            ? fileLineHtml(entry, row.n, marks)
            : renderLine(row.text, localTokens[i]!, [...marks, ...identifierMarks(localIds[i]!, marks, debug)]);
        const cls = [
          "line",
          ...(row.kind === "add" ? ["diff-add"] : []),
          ...(deco?.cls ?? []),
          ...(focus && row.n >= focus.startLine && row.n <= focus.endLine ? ["in-focus"] : []),
        ].join(" ");
        return { kind: "line", key: `l${i}:${row.n}`, cls, html: rowInner(row.n, width, html) };
      }
    }
  });
}

/** "+3 −1" for the scope bar, when the rows change anything. */
export function rowStat(rows: readonly DiffRow[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.kind === "add") adds++;
    else if (row.kind === "del") dels++;
  }
  return { adds, dels };
}
