import { useMemo, type JSX } from "react";
import {
  escapeHtml as esc,
  fileDiffRows,
  languageOf,
  markIntraLine,
  segmentRows,
  type CallPathResult,
  type CallSite,
  type Decorations,
  type DiffHunk,
  type DiffRow,
  type FileEntry,
  type FileIndex,
  type Mark,
  type PathNode,
  type SourceSegment,
} from "../../lib/callGraph.js";
import { CodePane } from "./CodePane.js";
import { usePanelScroll } from "./panelScroll.js";

/** Lines of surrounding file context shown around a function, like `diff -U10`. */
const PANEL_CONTEXT = 10;

function sitesFor(side: "before" | "after", edge: { before: CallSite[]; after: CallSite[] }): CallSite[] {
  return side === "after" ? edge.after : edge.before;
}

/** The presence badge a function carries: added, removed, changed, renamed. */
function PresenceBadge({ node }: { node: PathNode }): JSX.Element {
  if (node.renamedFrom) return <span className="badge renamed">renamed from {node.renamedFrom}</span>;
  if (node.presence === "both") {
    return node.changedInPr ? <span className="badge changed">changed</span> : <span className="badge">unchanged</span>;
  }
  const added = node.presence === "after";
  return <span className={`badge ${added ? "added" : "removed"}`}>{added ? "added in PR" : "removed in PR"}</span>;
}

interface CallerRow {
  key: string;
  target: string;
  name: string;
  line: number;
  snippet: string;
}

function panelRows(
  span: { startLine: number; endLine: number; source: SourceSegment[] },
  hunks: DiffHunk[],
  entry: FileEntry | undefined,
): DiffRow[] {
  const rows = entry
    ? fileDiffRows(entry.lines, hunks, { context: PANEL_CONTEXT, focus: span })
    : segmentRows(span.source, hunks);
  markIntraLine(rows);
  return rows;
}

/**
 * One function's card in the explorer: its badges, called-by rows, and its
 * diff with every outgoing call tappable. A port of `renderPanel`.
 */
export function NodePanel({
  node,
  graph,
  index,
  debug,
}: {
  node: PathNode;
  graph: CallPathResult;
  index: FileIndex;
  debug: boolean;
}): JSX.Element {
  const ref = usePanelScroll(node.id);
  const side: "before" | "after" = node.after ? "after" : "before";
  const snapshot = (node.after ?? node.before)!;
  const entry = index.get(`${side}:${snapshot.file}`);

  const { rows, decorations, callers } = useMemo(() => {
    // Hunks are in head coordinates; a before-only function shows plain source.
    const built = panelRows(snapshot, side === "after" ? node.hunks : [], entry);

    // Overlays on the diff: each outgoing call tappable, the declared name
    // marked. The call marks come from the language service's own call
    // hierarchy — and for a before-side panel, which the navigation server
    // cannot answer about, they are the only way to walk down.
    const deco: Decorations = new Map();
    for (const edge of graph.edges) {
      if (edge.from !== node.id) continue;
      for (const site of sitesFor(side, edge)) {
        if (site.startColumn === undefined || site.endColumn === undefined) continue;
        const existing = deco.get(site.line) ?? {};
        const mark: Mark = {
          start: site.startColumn,
          end: site.endColumn,
          cls: "csite",
          attrs: `data-target="${esc(edge.to)}" role="button" tabindex="0"`,
          ...(debug ? { why: `csite · call-graph edge ${node.id} → ${edge.to}` } : {}),
        };
        deco.set(site.line, { ...existing, marks: [...(existing.marks ?? []), mark] });
      }
    }

    // Mark the function's own name on its declaration line so the navigator
    // can tint it when this panel is opened from a click on that symbol.
    const bareName = node.name.split(".").pop() ?? node.name;
    const lineTextAt = (n: number): string =>
      entry
        ? (entry.lines[n - 1] ?? "")
        : (snapshot.source.map((seg) => (n >= seg.startLine ? seg.lines[n - seg.startLine] : undefined)).find((l) => l !== undefined) ?? "");
    let namePos: { line: number; column: number } | null = lineTextAt(node.nameLine).startsWith(bareName, node.nameColumn)
      ? { line: node.nameLine, column: node.nameColumn }
      : null;
    const nameFromService = namePos !== null;
    for (let n = snapshot.startLine; !namePos && n <= snapshot.endLine; n++) {
      const column = lineTextAt(n).indexOf(bareName);
      if (column >= 0) namePos = { line: n, column };
    }
    if (namePos) {
      const existing = deco.get(namePos.line) ?? {};
      deco.set(namePos.line, {
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

    // Incoming edges become tappable "called by" rows, one per call site.
    // Two distinct edges can resolve to what looks like the same caller, so
    // dedupe on what the reader actually sees.
    const nodeName = new Map(graph.nodes.map((n) => [n.id, n.name]));
    const seen = new Set<string>();
    const rowsIn: CallerRow[] = graph.edges
      .filter((edge) => edge.to === node.id)
      .flatMap((edge) => {
        const own = sitesFor(side, edge);
        const sites = own.length ? own : sitesFor(side === "after" ? "before" : "after", edge);
        const name = nodeName.get(edge.from) ?? edge.from;
        return sites
          .filter((site) => {
            const key = `${name} ${site.line} ${site.snippet}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((site) => ({ key: `${edge.from}:${site.line}:${site.snippet}`, target: edge.from, name, line: site.line, snippet: site.snippet }));
      });
    return { rows: built, decorations: deco, callers: rowsIn };
  }, [node, graph, entry, side, snapshot, debug]);

  return (
    <article className="panel" data-node={node.id} ref={ref}>
      <h3>
        <code className="fn-name">{node.name}</code> <PresenceBadge node={node} />
      </h3>
      <div className="side-loc">
        <code>
          {snapshot.file}:{snapshot.startLine}–{snapshot.endLine}
        </code>{" "}
        <span className="badge">{side}</span>
        {!node.expanded && (
          <>
            {" "}
            <span className="badge">boundary</span>
          </>
        )}
      </div>
      {callers.length > 0 && (
        <details className="fn called-by">
          <summary title="tap a row to walk up">called by ({callers.length})</summary>
          <div className="caller-rows">
            {callers.map((row) => (
              <button key={row.key} className="caller-row" data-target={row.target}>
                ↖ <code className="fn-name">{row.name}</code> <span className="loc">L{row.line}</span>{" "}
                <code>{row.snippet}</code>
              </button>
            ))}
          </div>
        </details>
      )}
      <CodePane
        file={snapshot.file}
        entry={entry}
        rows={rows}
        lang={languageOf(snapshot.file)}
        decorations={decorations}
        focus={snapshot}
        navigable={{ side }}
        debug={debug}
        stateKey={`${node.id}:${snapshot.file}`}
      />
    </article>
  );
}
