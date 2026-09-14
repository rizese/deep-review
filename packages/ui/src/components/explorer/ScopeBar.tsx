import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent, type RefObject } from "react";
import { scopeLabelFor, type FileEntry } from "../../lib/callGraph.js";

/**
 * The sticky header over a code pane: the file, the declaration the first
 * visible line sits in, and what the pane changes. Anywhere on it folds the
 * pane, GitHub-style. A port of the scope bar in `codePane.ts` and of the
 * label half of `SCOPE_JS`.
 */
export function ScopeBar({
  file,
  entry,
  initialLine,
  stat,
  collapsed,
  onToggle,
  preRef,
  revision,
}: {
  file: string;
  entry: FileEntry | undefined;
  initialLine: number;
  stat: { adds: number; dels: number };
  collapsed: boolean;
  onToggle: () => void;
  preRef: RefObject<HTMLPreElement | null>;
  /** Bumped whenever the pane's rows change, so the label is recomputed. */
  revision: number;
}): JSX.Element {
  const barRef = useRef<HTMLDivElement>(null);
  const [sym, setSym] = useState(() => (entry ? scopeLabelFor(entry.symbols, initialLine) : ""));

  const update = useCallback(() => {
    const bar = barRef.current;
    const pre = preRef.current;
    if (!bar || !pre || !entry) return;
    const line = firstVisibleLine(bar, pre);
    setSym(Number.isNaN(line) ? "" : scopeLabelFor(entry.symbols, line));
  }, [entry, preRef]);

  useEffect(() => {
    update();
  }, [update, revision]);

  // Panels are their own scroll containers; the bar follows the one it sits in.
  useEffect(() => {
    const pane = barRef.current?.closest(".panel");
    if (!pane) return;
    let queued = false;
    const onScroll = (): void => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => pane.removeEventListener("scroll", onScroll);
  }, [update]);

  const cut = file.lastIndexOf("/") + 1;
  const click = (e: MouseEvent): void => {
    // The bar's own controls, if any, keep their meaning.
    if ((e.target as Element).closest("a, button")) return;
    onToggle();
  };
  return (
    <div
      className="scope-bar"
      ref={barRef}
      {...(entry ? { "data-key": entry.key } : {})}
      aria-expanded={collapsed ? "false" : "true"}
      onClick={click}
    >
      <span className="scope-caret" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </span>
      <span className="scope-path">
        {cut > 0 && <span className="dir">{file.slice(0, cut)}</span>}
        <span className="name">{file.slice(cut)}</span>
      </span>
      <span className="scope-sym">{sym}</span>
      {(stat.adds > 0 || stat.dels > 0) && (
        <span className="stat">
          {stat.adds > 0 && <span className="plus">+{stat.adds}</span>}
          {stat.dels > 0 && <span className="minus">−{stat.dels}</span>}
        </span>
      )}
    </div>
  );
}

/**
 * Head line of the first row not scrolled under the bar: a binary search
 * over the rows and gaps, in document order.
 */
function firstVisibleLine(bar: Element, pre: Element): number {
  const limit = bar.getBoundingClientRect().bottom;
  const kids = (pre.querySelector(".lines") ?? pre).children;
  let lo = 0;
  let hi = kids.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kids[mid]!.getBoundingClientRect().bottom > limit) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  for (let i = Math.max(found, 0); i < kids.length; i++) {
    const el = kids[i]!;
    if (el.classList.contains("gap")) return Number((el as HTMLElement).dataset.from);
    const no = el.querySelector(".lineno");
    const n = no ? Number(no.textContent) : NaN;
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return NaN;
}
