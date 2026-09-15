import { renderCodePane } from "./codePane.js";
import { fileDiffRows, markIntraLine, segmentRows, type DiffRow } from "./diffView.js";
import { escapeHtml as esc, languageOf, type Mark } from "./highlight.js";
import {
  presenceBadge,
  type Decorations,
  type FileEntry,
  type FileIndex,
} from "./html.js";
import type {
  CallPathResult,
  CallSite,
  DefinitionTarget,
  DiffHunk,
  PathNode,
  SourceSegment,
} from "./types.js";

function sitesFor(side: "before" | "after", edge: { before: CallSite[]; after: CallSite[] }): CallSite[] {
  return side === "after" ? edge.after : edge.before;
}

/** Lines of surrounding file context shown around a function, like `diff -U10`. */
const PANEL_CONTEXT = 10;

/** Panel id of a definition: a graph node keeps its own; anything else is `def:<id>`. */
import { definitionPanelId } from "./navSession.js";

export { definitionPanelId };

export interface PanelOptions {
  /** Debug builds: every mark says where it came from (`data-why`). */
  debug?: boolean | undefined;
}

export interface DefinitionPanelOptions extends PanelOptions {
  /**
   * The PR's hunks over this declaration, head-side. Taken from the whole
   * diff rather than from a slice's fragments: which slice claimed the
   * change says nothing about whether the declaration changed.
   */
  hunks?: DiffHunk[] | undefined;
}

/**
 * The diff rows a panel shows for a declaration: the whole file's changes
 * and the declaration itself, each with context, when the file is embedded;
 * otherwise the source segments we have, with the hunks applied.
 */
function panelRows(
  span: LineSpanWithSource,
  hunks: DiffHunk[],
  entry: FileEntry | undefined,
): DiffRow[] {
  const rows = entry
    ? fileDiffRows(entry.lines, hunks, { context: PANEL_CONTEXT, focus: span })
    : segmentRows(span.source, hunks);
  markIntraLine(rows);
  return rows;
}

interface LineSpanWithSource {
  startLine: number;
  endLine: number;
  source: SourceSegment[];
}

export function renderPanel(
  node: PathNode,
  result: CallPathResult,
  index: FileIndex,
  options: PanelOptions = {},
): string {
  const debug = options.debug ?? false;
  const side: "before" | "after" = node.after ? "after" : "before";
  const snapshot = (node.after ?? node.before)!;
  const entry = index.get(`${side}:${snapshot.file}`);

  // Hunks are in head coordinates; a before-only function shows plain source.
  const rows = panelRows(snapshot, side === "after" ? node.hunks : [], entry);

  // Overlays on the diff: each outgoing call tappable, the declared name
  // marked. The call marks come from the language service's own call
  // hierarchy, exact and free — and for a before-side panel, which the
  // navigation server (head checkout only) cannot answer about, they are
  // the only way to walk down.
  const decorations: Decorations = new Map();
  for (const edge of result.edges) {
    if (edge.from !== node.id) continue;
    for (const site of sitesFor(side, edge)) {
      if (site.startColumn === undefined || site.endColumn === undefined) continue;
      const existing = decorations.get(site.line) ?? {};
      const mark: Mark = {
        start: site.startColumn,
        end: site.endColumn,
        cls: "csite",
        attrs: `data-target="${esc(edge.to)}" role="button" tabindex="0"`,
        ...(debug ? { why: `csite · call-graph edge ${node.id} → ${edge.to}` } : {}),
      };
      decorations.set(site.line, { ...existing, marks: [...(existing.marks ?? []), mark] });
    }
  }

  // Mark the function's own name on its declaration line so the navigator
  // can tint it when this panel is opened from a click on that symbol. The
  // language service gives the exact position; fall back to a text search
  // across the span (the name may sit below a JSDoc block within it).
  const bareName = node.name.split(".").pop() ?? node.name;
  const lineTextAt = (n: number): string =>
    entry
      ? (entry.lines[n - 1] ?? "")
      : (snapshot.source
          .map((seg) => (n >= seg.startLine ? seg.lines[n - seg.startLine] : undefined))
          .find((l) => l !== undefined) ?? "");
  let namePos: { line: number; column: number } | null =
    lineTextAt(node.nameLine).startsWith(bareName, node.nameColumn)
      ? { line: node.nameLine, column: node.nameColumn }
      : null;
  const nameFromService = namePos !== null;
  for (let n = snapshot.startLine; !namePos && n <= snapshot.endLine; n++) {
    const column = lineTextAt(n).indexOf(bareName);
    if (column >= 0) namePos = { line: n, column };
  }
  if (namePos) {
    const existing = decorations.get(namePos.line) ?? {};
    decorations.set(namePos.line, {
      ...existing,
      marks: [
        ...(existing.marks ?? []),
        {
          start: namePos.column,
          end: namePos.column + bareName.length,
          cls: "self-sym",
          ...(debug
            ? { why: `decl · ${node.name}, graph node ${node.id} (${nameFromService ? "language service" : "text search"})` }
            : {}),
        },
      ],
    });
  }

  // Incoming edges become tappable "called by" rows, one per call site,
  // folded away by default: a widely used function has dozens, and the
  // code is what the panel is for.
  const nodeName = new Map(result.nodes.map((n) => [n.id, n.name]));
  // Two distinct edges can resolve to what looks like the same caller (same
  // displayed name, same call-site line) — e.g. a caller the graph walk
  // reached through two different paths and never fully merged. Dedupe on
  // what the user actually sees, so a real caller never appears twice.
  const seenCallerRows = new Set<string>();
  const callerRows = result.edges
    .filter((edge) => edge.to === node.id)
    .flatMap((edge) => {
      const sites = sitesFor(side, edge).length ? sitesFor(side, edge) : sitesFor(side === "after" ? "before" : "after", edge);
      const name = nodeName.get(edge.from) ?? edge.from;
      return sites
        .filter((site) => {
          const key = `${name} ${site.line} ${site.snippet}`;
          if (seenCallerRows.has(key)) return false;
          seenCallerRows.add(key);
          return true;
        })
        .map(
          (site) =>
            `<button class="caller-row" data-target="${esc(edge.from)}">↖ <code class="fn-name">${esc(
              name,
            )}</code> <span class="loc">L${site.line}</span> <code>${esc(site.snippet)}</code></button>`,
        );
    });
  const calledBy = callerRows.length
    ? `<details class="fn called-by"><summary title="tap a row to walk up">called by (${callerRows.length})</summary><div class="caller-rows">${callerRows.join("")}</div></details>`
    : "";

  return `<article class="panel" data-node="${esc(node.id)}">
    <h3><code class="fn-name">${esc(node.name)}</code> ${presenceBadge(node)}</h3>
    <div class="side-loc"><code>${esc(snapshot.file)}:${snapshot.startLine}–${snapshot.endLine}</code> <span class="badge">${side}</span>${
      node.expanded ? "" : ' <span class="badge">boundary</span>'
    }</div>
    ${calledBy}
    ${renderCodePane({
      file: snapshot.file,
      entry,
      rows,
      lang: languageOf(snapshot.file),
      decorations,
      focus: snapshot,
      navigable: { side },
      debug,
    })}
  </article>`;
}

/**
 * A panel for a definition the call graph did not reach — a class, a
 * constant, an import, a local, or something in a dependency. Same card as
 * a function's, minus the called-by rows the call graph would supply. Its
 * diff comes from the PR instead, so the panel shades the same whichever
 * slice the reader opened it from. Rendered by the navigation server when a
 * reader first opens it.
 */
export function renderDefinitionPanel(
  def: DefinitionTarget,
  index: FileIndex,
  options: DefinitionPanelOptions = {},
): string {
  const debug = options.debug ?? false;
  // A window wins when present: the file is not on the page whole.
  const entry = def.external || def.source ? undefined : index.get(`after:${def.file}`);
  if (!entry && !def.source) return "";
  const rows = panelRows({ ...def, source: def.source ? [def.source] : [] }, options.hunks ?? [], entry);

  const decorations: Decorations = new Map();
  decorations.set(def.nameLine, {
    marks: [
      {
        start: def.nameColumn,
        end: def.nameEndColumn,
        cls: "self-sym",
        attrs: `data-decl="${esc(def.id)}"`,
        ...(debug ? { why: `decl · ${def.name} (${def.kind}) ${def.id}` } : {}),
      },
    ],
  });

  // External paths are absolute and machine-specific: show the basename only.
  const shownFile = def.external ? def.file.slice(def.file.lastIndexOf("/") + 1) : def.file;
  return `<article class="panel" data-node="${esc(definitionPanelId(def))}">
    <h3><code class="fn-name">${esc(def.name)}</code> <span class="badge">${esc(def.kind)}</span>${
      def.external ? ' <span class="badge">external</span>' : ""
    }</h3>
    <div class="side-loc"><code>${esc(shownFile)}:${def.startLine}–${def.endLine}</code> <span class="badge">after</span></div>
    ${renderCodePane({
      file: shownFile,
      entry,
      rows,
      lang: languageOf(def.file),
      decorations,
      focus: def,
      // The pane answers clicks by the path the language service knows.
      navigable: { side: "after", file: def.file },
      debug,
    })}
  </article>`;
}
