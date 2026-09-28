import { useMemo, type JSX } from "react";
import type { SliceExplorerInput } from "../../lib/callGraph.js";
import { explorerSize } from "../../lib/size.js";
import { SizeBar } from "../SizeBar.js";
import { History, type Trail } from "./History.js";
import styles from "./Explorer.module.css";

/**
 * The floating card down the left: which PR this is and how big, the two
 * kinds of destination the page offers — its prose, or one of its slices —
 * and the trail of where the reader has walked.
 */
export function Sidebar({
  input,
  current,
  onPickSlice,
  onPickDescription,
  trails,
  historyCollapsed,
  onToggleHistory,
  onPickStep,
}: {
  input: SliceExplorerInput;
  current: number;
  onPickSlice: (i: number) => void;
  onPickDescription: () => void;
  trails: Map<number, Trail[]>;
  historyCollapsed: boolean;
  onToggleHistory: () => void;
  onPickStep: (slice: number, index: number) => void;
}): JSX.Element {
  const size = useMemo(() => explorerSize(input), [input]);
  return (
    <aside className="side">
      <div>
        <a className="pr" href={input.prUrl}>
          {input.repo}#{input.number}
        </a>
        <div className="pr-title">{input.prTitle}</div>
        <SizeBar size={size} className={styles.sideDelta} />
      </div>
      <nav>
        <div className="slice-nav">
          <button className="side-link doc-link" type="button" onClick={onPickDescription}>
            PR Description
          </button>
        </div>
        <div className="side-label">
          Slices · <span className="progress-label">{`${current + 1} / ${input.slices.length}`}</span>
        </div>
        <div className="slice-nav">
          {input.slices.map((slice, i) => (
            <button
              key={slice.id}
              className={`side-link slice-link${i === current ? " on" : ""}`}
              title={`${i + 1}. ${slice.title}`}
              onClick={() => onPickSlice(i)}
            >
              <span className="n">{i + 1}</span> {slice.title}
            </button>
          ))}
        </div>
      </nav>
      <History
        slices={input.slices.length}
        current={current}
        trails={trails}
        collapsed={historyCollapsed}
        onToggle={onToggleHistory}
        onPick={onPickStep}
      />
      <div className="foot">scroll past the end of a slice to reach the next</div>
    </aside>
  );
}
