import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";

const OUT_MS = 160;

/**
 * The routed page, crossfaded: when the address changes, what is showing
 * fades to nothing, then the new page is put in its place and fades up.
 * While on one address the live children render as usual; the snapshot is
 * only held for the moment of leaving.
 */
export function PageFade({ path, children }: { path: string; children: ReactNode }): JSX.Element {
  const [shown, setShown] = useState<{ path: string; node: ReactNode }>({ path, node: children });
  const [leaving, setLeaving] = useState(false);
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

  const live = shown.path === path;
  return (
    <div key={shown.path} className={`page-fade ${leaving ? "out" : "in"}`}>
      {live ? children : shown.node}
    </div>
  );
}
