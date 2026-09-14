import type { JSX } from "react";
import { scopeChainFor, type FileEntry, type SymbolRange } from "../../lib/callGraph.js";
import { EXPAND_STEP } from "../../lib/codeRows.js";

function symbolLabel(symbol: SymbolRange): string {
  return ["class", "interface", "enum", "namespace"].includes(symbol.kind)
    ? `${symbol.kind} ${symbol.name}`
    : `${symbol.name}()`;
}

/** Breadcrumb on expanders: "class Ky › #retry()". */
function crumbFor(symbols: readonly SymbolRange[], line: number): string {
  return scopeChainFor(symbols, line).map(symbolLabel).join(" › ");
}

/**
 * The GitHub-style expander standing in for hidden lines: ▲ reveals the
 * gap's bottom, ▼ its top, ↕ the whole of a short one. A port of `gapRow`
 * and the click half of `the page's former gap script`.
 */
export function Gap({
  entry,
  from,
  to,
  onExpand,
}: {
  entry: FileEntry | undefined;
  from: number;
  to: number;
  onExpand: (which: "up" | "down" | "all") => void;
}): JSX.Element {
  const count = to - from + 1;
  if (!entry) {
    // Nothing to expand into: the file's text is not on the page.
    return (
      <div className="gap static">
        <span className="gap-count">⋯ {count} hidden lines</span>
      </div>
    );
  }
  const crumb = crumbFor(entry.symbols, Math.min(to + 1, entry.lines.length));
  return (
    <div className="gap" data-key={entry.key} data-from={from} data-to={to}>
      <span className="gap-btns">
        {count <= EXPAND_STEP ? (
          <button className="gap-btn gap-all" title="Expand all" onClick={() => onExpand("all")}>
            ↕
          </button>
        ) : (
          <>
            <button className="gap-btn gap-up" title="Expand up" onClick={() => onExpand("up")}>
              ▲
            </button>
            <button className="gap-btn gap-down" title="Expand down" onClick={() => onExpand("down")}>
              ▼
            </button>
          </>
        )}
      </span>
      <span className="gap-count">⋯ {count} hidden lines</span>
      {crumb && <span className="gap-crumb">{crumb}</span>}
    </div>
  );
}
