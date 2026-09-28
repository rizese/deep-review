import { useEffect, useRef, type RefObject } from "react";

/**
 * Where each panel was last scrolled to. A panel walked away from is
 * unmounted, not discarded: it comes back where the reader left it, the way
 * the server-rendered page kept the detached element itself.
 */
const scrolls = new Map<string, number>();

export function usePanelScroll(id: string): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const kept = scrolls.get(id);
    if (kept !== undefined) el.scrollTop = kept;
    return () => {
      scrolls.set(id, el.scrollTop);
    };
  }, [id]);
  return ref;
}
