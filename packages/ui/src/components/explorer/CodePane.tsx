import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { firstHeadLine, rowsWidth, type Decorations, type DiffRow, type FileEntry, type Language, type LineSpan } from "../../lib/callGraph.js";
import { buildPaneRows, EXPAND_STEP, revealedRow, rowStat, type PaneRow } from "../../lib/codeRows.js";
import { Gap } from "./Gap.js";
import { ScopeBar } from "./ScopeBar.js";

/** How far each gap of a pane has been expanded; null once it is gone entirely. */
type GapState = Map<string, { from: number; to: number } | null>;

/**
 * A pane keeps the gaps its reader expanded even while its panel is off the
 * track, the way the server-rendered page kept the detached element itself.
 * Keyed by panel and file, so the same pane comes back as it was left.
 */
const expandedGaps = new Map<string, GapState>();

const MARKDOWN_FILE = /\.mdx?$/i;

export interface CodePaneProps {
  /** Path shown in the header: repo-relative, or a basename for an external file. */
  file: string;
  entry: FileEntry | undefined;
  rows: readonly DiffRow[];
  lang: Language;
  decorations?: Decorations | undefined;
  focus?: LineSpan | undefined;
  navigable?: { side: "before" | "after"; file?: string } | undefined;
  debug?: boolean | undefined;
  /** Where this pane's expanded gaps are remembered; unique on the page. */
  stateKey: string;
}

/**
 * The one way a panel shows code: a sticky scope header over a unified
 * diff, folded by a click on the header. A port of `renderCodePane`, with
 * the rows, gaps and expanders owned here and each line's content still the
 * analysis package's own rendering.
 */
export function CodePane(props: CodePaneProps): JSX.Element {
  const { file, entry, rows, lang, decorations, focus, navigable, debug, stateKey } = props;
  const paneRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [gaps, setGaps] = useState<GapState>(() => expandedGaps.get(stateKey) ?? new Map());

  const width = useMemo(() => rowsWidth(rows, entry), [rows, entry]);
  const paneRows = useMemo(
    () => buildPaneRows(rows, { width, lang, entry, decorations, focus, debug }),
    [rows, width, lang, entry, decorations, focus, debug],
  );
  const stat = useMemo(() => rowStat(rows), [rows]);
  const wrap = MARKDOWN_FILE.test(file);

  const expand = (row: Extract<PaneRow, { kind: "gap" }>, which: "up" | "down" | "all"): void => {
    const current = gaps.get(row.key) ?? { from: row.from, to: row.to };
    if (current === null) return;
    const next = new Map(gaps);
    if (which === "all" || current.to - current.from + 1 <= EXPAND_STEP) next.set(row.key, null);
    else if (which === "down") next.set(row.key, { from: current.from + EXPAND_STEP, to: current.to });
    else next.set(row.key, { from: current.from, to: current.to - EXPAND_STEP });
    expandedGaps.set(stateKey, next);
    setGaps(next);
  };

  // Folding is one transition of the source's max-height between 0 and its
  // measured height, so closing and opening are the same motion run in
  // opposite directions. The cap is measured, never auto: a transition needs
  // two lengths, and the same two in both directions.
  const toggleFold = (): void => {
    const pane = paneRef.current;
    const pre = preRef.current;
    if (!pane || !pre) return;
    const folding = !collapsed;
    let height: number;
    if (folding) {
      height = pre.offsetHeight;
    } else {
      // The height it will have, found by unfolding it for one silent
      // layout with transitions off and folding it back again.
      pre.style.transition = "none";
      pane.classList.remove("collapsed");
      height = pre.offsetHeight;
      pane.classList.add("collapsed");
      void pre.offsetHeight;
      pre.style.transition = "";
    }
    pane.style.setProperty("--pane-h", `${height}px`);
    void pre.offsetHeight;
    flushSync(() => setCollapsed(folding));
  };

  // Open again, the cap comes off, so a pane that later grows — a gap
  // expanded — is not clipped at the height it happened to have.
  const transitionEnd = (e: { propertyName: string }): void => {
    if (e.propertyName !== "max-height") return;
    if (!collapsed) paneRef.current?.style.removeProperty("--pane-h");
  };

  useWrapTicks(preRef, wrap, paneRows);

  const children: ReactNode[] = [];
  for (const row of paneRows) {
    if (row.kind === "line") {
      children.push(<span key={row.key} className={row.cls} dangerouslySetInnerHTML={{ __html: row.html }} />);
      continue;
    }
    const state = gaps.get(row.key);
    const from = state === undefined ? row.from : state === null ? row.to + 1 : state.from;
    const to = state === undefined ? row.to : state === null ? row.to : state.to;
    if (entry) for (let n = row.from; n < from; n++) children.push(lineEl(entry, n, width));
    if (from <= to) {
      children.push(
        <Gap key={row.key} entry={entry} from={from} to={to} onExpand={(which) => expand(row, which)} />,
      );
    }
    if (entry) for (let n = to + 1; n <= row.to; n++) children.push(lineEl(entry, n, width));
  }

  return (
    <div
      className={`code-pane${collapsed ? " collapsed" : ""}`}
      ref={paneRef}
      {...(navigable ? { "data-file": navigable.file ?? file, "data-side": navigable.side } : {})}
    >
      <ScopeBar
        file={file}
        entry={entry}
        initialLine={firstHeadLine(rows)}
        stat={stat}
        collapsed={collapsed}
        onToggle={toggleFold}
        preRef={preRef}
        revision={gaps.size}
      />
      <pre
        className={`source${wrap ? " wrap" : ""}`}
        ref={preRef}
        data-w={width}
        {...(wrap ? { style: { ["--gutter" as string]: width } } : {})}
        onTransitionEnd={transitionEnd}
      >
        <span className="lines">{children}</span>
      </pre>
    </div>
  );
}

/** One line an expander revealed: the file's own base rendering, undecorated. */
function lineEl(entry: FileEntry, n: number, width: number): JSX.Element {
  const row = revealedRow(entry, n, width);
  return <span key={row.key} className={row.cls} dangerouslySetInnerHTML={{ __html: row.html }} />;
}

/**
 * A small glyph in the gutter at the start of each visual row a wrapped
 * line continues onto. Wrapping depends on the pane's rendered width, so
 * the pane is watched rather than measured once. A port of `WRAP_JS`.
 */
function useWrapTicks(preRef: { current: HTMLPreElement | null }, wrap: boolean, rows: readonly PaneRow[]): void {
  useEffect(() => {
    const pre = preRef.current;
    if (!wrap || !pre) return;
    const mark = (): void => {
      const lineHeight = parseFloat(getComputedStyle(pre).lineHeight);
      if (!lineHeight) return;
      for (const line of pre.querySelectorAll(".line")) {
        for (const tick of line.querySelectorAll(".wrap-tick")) tick.remove();
        const count = Math.round(line.getBoundingClientRect().height / lineHeight);
        for (let r = 1; r < count; r++) {
          const tick = document.createElement("span");
          tick.className = "wrap-tick";
          tick.style.top = `${r * lineHeight}px`;
          line.appendChild(tick);
        }
      }
    };
    if (typeof ResizeObserver === "undefined") {
      mark();
      return;
    }
    const observer = new ResizeObserver(mark);
    observer.observe(pre);
    return () => observer.disconnect();
  }, [preRef, wrap, rows]);
}
