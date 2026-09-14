import { useEffect, useRef, type JSX, type ReactNode } from "react";

/**
 * How much overscroll past an edge commits to the next slice. One firm
 * trackpad flick clears this; a coasting scroll that merely lands on the
 * boundary does not.
 */
const THRESHOLD = 550;

/**
 * The vertical axis: slices stacked, one filling the stage at a time.
 * Scrolling inside a slice behaves normally until it runs out of content;
 * pushing past the end carries the reader to the next slice, and past the
 * top to the previous one. A port of `DECK_JS`.
 */
export function Deck({
  current,
  titles,
  locked,
  onGo,
  children,
}: {
  current: number;
  titles: string[];
  /** True while a slice change is still animating; wheel events are swallowed. */
  locked: () => boolean;
  onGo: (next: number, from: "above" | "below") => void;
  children: ReactNode;
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const overscroll = useRef(0);
  const overscrollDown = useRef(true);
  const lastWheel = useRef(0);
  const count = titles.length;

  // React's own wheel listener is passive, and the overscroll has to be able
  // to swallow the event — so this one is attached by hand.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (e: WheelEvent): void => {
      if (locked()) {
        e.preventDefault();
        return;
      }
      const pane = (e.target as Element).closest(".panel");
      const down = e.deltaY > 0;
      const edge = down ? atBottom(pane) : atTop(pane);
      if (!edge) {
        overscroll.current = 0;
        return;
      }
      const last = down ? current >= count - 1 : current <= 0;
      if (last) {
        overscroll.current = 0;
        return;
      }
      e.preventDefault();
      // A pane shorter than the viewport is at its top and its bottom at
      // once, so the tally has to be per-direction or an up-scroll would
      // bank credit toward advancing downward.
      if (down !== overscrollDown.current) {
        overscroll.current = 0;
        overscrollDown.current = down;
      }
      // Forget a stale tally: three gentle nudges minutes apart should not
      // add up to a slice change the reader never asked for.
      const now = Date.now();
      if (now - lastWheel.current > 400) overscroll.current = 0;
      lastWheel.current = now;
      overscroll.current += Math.abs(e.deltaY);
      if (overscroll.current >= THRESHOLD) {
        overscroll.current = 0;
        onGo(current + (down ? 1 : -1), down ? "above" : "below");
      }
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, [current, count, locked, onGo]);

  // Paging belongs to the slice deck; while the description is showing, the
  // keys should scroll the prose the reader is looking at.
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (document.body.classList.contains("showing-description")) return;
      if (e.key === "PageDown") {
        e.preventDefault();
        onGo(current + 1, "above");
      } else if (e.key === "PageUp") {
        e.preventDefault();
        onGo(current - 1, "below");
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [current, onGo]);

  return (
    <div className={`stage${current > 0 ? " can-up" : ""}${current < count - 1 ? " can-down" : ""}`} ref={stageRef}>
      <button className="vrail vrail-up" onClick={() => onGo(current - 1, "below")}>
        {current > 0 ? `▲ ${titles[current - 1]}` : ""}
      </button>
      <button className="vrail vrail-down" onClick={() => onGo(current + 1, "above")}>
        {current < count - 1 ? `${titles[current + 1]} ▼` : ""}
      </button>
      <div className="deck" style={{ ["--slice" as string]: String(current) }}>
        {children}
      </div>
    </div>
  );
}

function atTop(el: Element | null): boolean {
  return !el || el.scrollTop <= 1;
}

function atBottom(el: Element | null): boolean {
  return !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
}
