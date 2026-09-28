import { createContext, useContext, useEffect, useRef, useState, type JSX, type ReactNode } from "react";

const OUT_MS = 160;

/**
 * Readiness, as pages report it. A page whose content arrives later — the
 * explorer waiting for its input, the index waiting for the first snapshot
 * — holds the fade-in until it has something to show, so what fades in is
 * the page, not an empty box the page then pops into. A page that says
 * nothing is ready at once.
 */
const ReadyContext = createContext<{ hold: () => () => void } | null>(null);

/**
 * Tell the crossfade whether this page has its content yet. Call it with
 * `false` while loading and `true` once there is something to show; the
 * page fades in when every hold is released.
 */
export function usePageReady(ready: boolean): void {
  const ctx = useContext(ReadyContext);
  useEffect(() => {
    if (!ctx || ready) return;
    return ctx.hold();
  }, [ctx, ready]);
}

/**
 * The routed page, crossfaded: when the address changes, what is showing
 * fades to nothing, the new page is put in its place, and once it is ready
 * it fades up. While on one address the live children render as usual; the
 * snapshot is only held for the moment of leaving.
 */
export function PageFade({ path, children }: { path: string; children: ReactNode }): JSX.Element {
  const [shown, setShown] = useState<{ path: string; node: ReactNode }>({ path, node: children });
  const [leaving, setLeaving] = useState(false);
  const [holds, setHolds] = useState(0);
  const latest = useRef(children);
  latest.current = children;

  useEffect(() => {
    if (path === shown.path) return;
    setLeaving(true);
    const timer = setTimeout(() => {
      setShown({ path, node: latest.current });
      setLeaving(false);
    }, OUT_MS);
    return () => clearTimeout(timer);
  }, [path, shown.path]);

  const ready = useRef({
    hold: () => {
      setHolds((n) => n + 1);
      return () => setHolds((n) => n - 1);
    },
  }).current;

  const live = shown.path === path;
  // "waiting" carries no animation; "in" does, and a CSS animation starts
  // the moment the class that carries it is added — so a page that becomes
  // ready fades in then, with no remount (which would reset its loading
  // state and hold it again).
  const phase = leaving ? "out" : holds > 0 ? "waiting" : "in";
  return (
    <ReadyContext.Provider value={ready}>
      <div key={shown.path} className={`page-fade ${phase}`}>
        {live ? children : shown.node}
      </div>
    </ReadyContext.Provider>
  );
}
