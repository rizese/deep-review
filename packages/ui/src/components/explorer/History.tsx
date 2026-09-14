import type { JSX } from "react";
import type { DestDesc, LinkDesc } from "./Track.js";

/** One waypoint of a slice's walk, as the sidebar lists it. */
export interface Trail {
  id: string;
  ids: string[];
  anchors: (DestDesc | null)[];
  link: LinkDesc | null;
  pos: number;
  label: string;
}

/**
 * A collapsible breadcrumb trail per slice. Every walk into a caller or
 * callee appends a step; clicking an earlier step restores the track to
 * exactly that arrangement and drops everything after it, the way browser
 * history does. Each slice keeps its own trail. A port of `the page's former history script`.
 */
export function History({
  slices,
  current,
  trails,
  collapsed,
  onToggle,
  onPick,
}: {
  slices: number;
  current: number;
  trails: Map<number, Trail[]>;
  collapsed: boolean;
  onToggle: () => void;
  onPick: (slice: number, index: number) => void;
}): JSX.Element {
  return (
    <div className={`history-block${collapsed ? " collapsed" : ""}`}>
      <button className="history-toggle" type="button" onClick={onToggle}>
        <span className="side-label">History</span>
        <span className="chev">▾</span>
      </button>
      <div className="history-body">
        {Array.from({ length: slices }, (_, i) => (
          <div key={i} className="history-panel" data-slice={i} hidden={i !== current}>
            {(trails.get(i) ?? []).map((step, idx, all) => (
              <button
                key={idx}
                className={`history-entry${idx === all.length - 1 ? " on" : ""}`}
                data-idx={idx}
                onClick={() => onPick(i, idx)}
              >
                <span className="n">{idx + 1}</span> {step.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
