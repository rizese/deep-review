import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Chrome } from "../components/Chrome.js";
import { Deck } from "../components/explorer/Deck.js";
import { DebugMarks } from "../components/explorer/DebugMarks.js";
import { Description } from "../components/explorer/Description.js";
import { Sidebar } from "../components/explorer/Sidebar.js";
import { Track, type DestDesc, type NavStep, type Restore } from "../components/explorer/Track.js";
import type { Trail } from "../components/explorer/History.js";
import { buildFileIndex, type CallPathResult, type PathNode, type SliceExplorerInput } from "../lib/callGraph.js";
import { defNames, watchPageLife } from "../lib/nav.js";
import { useStored } from "../lib/useStored.js";
import "../styles/source.css";
import "../styles/explorer.css";

/** How long a slice change is locked while it slides. */
const SLIDE_MS = 520;

/**
 * The two axes fused: slices stacked vertically in priority order, and each
 * slice's call graph walkable horizontally from the symbols in its diff. A
 * port of `the former server-rendered explorer` and the client JS that came with it.
 */
export function Explorer({ input, count }: { input: SliceExplorerInput; count: number }): JSX.Element {
  const [current, setCurrent] = useState(0);
  const [showingDescription, setShowingDescription] = useState(false);
  const [trails, setTrails] = useState<Map<number, Trail[]>>(
    () => new Map(input.slices.map((slice, i) => [i, [{ id: "__slice__", ids: ["__slice__"], anchors: [null], link: null, pos: 0, label: slice.title }]])),
  );
  const [historyStored, setHistoryStored] = useStored("history-collapsed", "0");
  const locked = useRef(false);
  const restores = useRef(new Map<number, Restore>());
  const debug = input.debugMarks ?? false;

  const index = useMemo(
    () => buildFileIndex([...input.files, ...input.slices.flatMap((s) => s.graph?.files ?? [])], { debug }),
    [input, debug],
  );
  // Every graph node on the page, whichever slice walked it: a function
  // reached from one slice's call path is the same function from another.
  const nodes = useMemo(() => {
    const all = new Map<string, { node: PathNode; graph: CallPathResult }>();
    for (const slice of input.slices) {
      const graph = slice.graph;
      if (!graph) continue;
      for (const node of graph.nodes) if (!all.has(node.id)) all.set(node.id, { node, graph });
    }
    return all;
  }, [input]);
  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, { node }] of nodes) out[id] = node.name;
    return out;
  }, [nodes]);
  const titles = useMemo(() => input.slices.map((s) => s.title), [input]);

  // The page is a grid on the body, as the server's page was; the bar is
  // compact over a PR. #root would otherwise be the grid's only child.
  useEffect(() => {
    document.body.classList.add("slice-explorer", "compact");
    return () => document.body.classList.remove("slice-explorer", "compact");
  }, []);
  useEffect(() => {
    document.body.classList.toggle("showing-description", showingDescription);
  }, [showingDescription]);
  useEffect(() => (input.navBase ? watchPageLife(input.navBase) : undefined), [input.navBase]);

  /**
   * Land where the reader was heading: entering from above starts at the top
   * of the new slice, entering from below starts at its bottom, so the
   * motion reads as one continuous column.
   */
  const go = useCallback(
    (next: number, from: "above" | "below"): void => {
      if (next < 0 || next >= titles.length || next === current) return;
      locked.current = true;
      setCurrent(next);
      for (const panel of document.querySelectorAll<HTMLElement>(`.slice-view[data-slice="${next}"] .panel`)) {
        panel.scrollTop = from === "below" ? panel.scrollHeight : 0;
      }
      setTimeout(() => {
        locked.current = false;
      }, SLIDE_MS);
    },
    [current, titles.length],
  );

  const navigate = useCallback(
    (slice: number, step: NavStep): void => {
      setTrails((previous) => {
        const trail = previous.get(slice) ?? [];
        // Landing on a state the trail already recorded — the same track
        // composition AND the same slot in view — is not a new step. The id
        // alone is not enough: a fresh path can land on a node the trail
        // visited earlier in a different arrangement, and that deserves its
        // own entry rather than a merge into the old one.
        let found = -1;
        for (let k = trail.length - 1; k >= 0; k--) {
          if (trail[k]!.pos === step.pos && sameIds(trail[k]!.ids, step.ids)) {
            found = k;
            break;
          }
        }
        const next =
          found >= 0
            ? trail.slice(0, found + 1)
            : [...trail, { id: step.id, ids: step.ids, anchors: step.anchors, link: step.link, pos: step.pos, label: names[step.id] ?? defNames.get(step.id) ?? step.id }];
        return new Map(previous).set(slice, next);
      });
    },
    [names],
  );

  const register = useCallback((slice: number, restore: Restore): void => {
    restores.current.set(slice, restore);
  }, []);

  const pickStep = useCallback((slice: number, idx: number): void => {
    const restore = restores.current.get(slice);
    setTrails((previous) => {
      const trail = previous.get(slice) ?? [];
      const step = trail[idx];
      if (step && restore) void restore(step.ids, step.pos, step.anchors as (DestDesc | null)[], step.link);
      return new Map(previous).set(slice, trail.slice(0, idx + 1));
    });
  }, []);

  return (
    <>
      <Chrome count={count} />
      <Sidebar
        input={input}
        current={current}
        onPickSlice={(i) => {
          setShowingDescription(false);
          go(i, "above");
        }}
        onPickDescription={() => setShowingDescription(true)}
        trails={trails}
        historyCollapsed={historyStored === "1"}
        onToggleHistory={() => setHistoryStored(historyStored === "1" ? "0" : "1")}
        onPickStep={pickStep}
      />
      <div className="main">
        <Deck current={current} titles={titles} locked={() => locked.current} onGo={go}>
          {input.slices.map((slice, i) => (
            <section key={slice.id} className="slice-view" data-slice={i}>
              <Track
                slice={slice}
                sliceIndex={i}
                total={input.slices.length}
                index={index}
                navBase={input.navBase ?? ""}
                debug={debug}
                names={names}
                nodes={nodes}
                onNavigate={(step) => navigate(i, step)}
                registerRestore={register}
              />
            </section>
          ))}
        </Deck>
        <Description input={input} />
      </div>
      {debug && <DebugMarks />}
    </>
  );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
