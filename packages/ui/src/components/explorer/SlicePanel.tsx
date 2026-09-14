import { useMemo, type JSX } from "react";
import { fragmentDiffRows, languageOf, type FileIndex, type SliceFragmentInput, type SliceInput } from "../../lib/callGraph.js";
import { fragmentSize } from "../../lib/size.js";
import { SizeBar } from "../SizeBar.js";
import { CodePane } from "./CodePane.js";
import { usePanelScroll } from "./panelScroll.js";
import styles from "./Explorer.module.css";

/** The first panel in a slice's track: what the PR changed for this one purpose. */
export function SlicePanel({
  slice,
  rank,
  total,
  index,
  debug,
}: {
  slice: SliceInput;
  rank: number;
  total: number;
  index: FileIndex;
  debug: boolean;
}): JSX.Element {
  const ref = usePanelScroll(`${rank}:__slice__`);
  // Group by file, keeping the order the slice listed them in, so the most
  // important file of the slice still leads.
  const panes = useMemo(() => {
    const groups = new Map<string, SliceFragmentInput[]>();
    for (const fragment of slice.fragments) {
      const group = groups.get(fragment.file);
      if (group) group.push(fragment);
      else groups.set(fragment.file, [fragment]);
    }
    return [...groups].map(([file, group]) => {
      const entry = index.get(`after:${file}`);
      return { file, entry, rows: fragmentDiffRows(entry?.lines, group), lang: languageOf(file) };
    });
  }, [slice, index]);
  const files = new Set(slice.fragments.map((f) => f.file));
  const size = useMemo(() => fragmentSize(slice.fragments), [slice]);

  return (
    <article className="panel slice-panel" data-node="__slice__" ref={ref}>
      <span className="eyebrow">
        Slice {rank} of {total}
      </span>
      <h3 className="slice-title">{slice.title}</h3>
      <p className="slice-summary">{slice.summary}</p>
      <p className="slice-rationale">{slice.rationale}</p>
      <div className="slice-badges">
        <SizeBar size={size} className={styles.badgeDelta} />
        <span className="badge">
          {files.size} file{files.size === 1 ? "" : "s"}
        </span>
        {slice.target && <span className="badge target">→ {slice.target.name}</span>}
        {!slice.graph && <span className="badge">no call graph</span>}
        <span className="hint">tap a symbol to open its definition · ⌘-click for its callers</span>
      </div>
      {panes.map((pane) => (
        <CodePane
          key={pane.file}
          file={pane.file}
          entry={pane.entry}
          rows={pane.rows}
          lang={pane.lang}
          navigable={{ side: "after" }}
          debug={debug}
          stateKey={`${rank}:__slice__:${pane.file}`}
        />
      ))}
    </article>
  );
}
