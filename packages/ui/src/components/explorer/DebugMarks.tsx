import { useEffect, type JSX } from "react";
import "../../styles/debugMarks.css";

/**
 * Debug builds: hold Shift and hover a span to see why it is marked, and a
 * legend saying what the colours mean. Nothing shows until Shift is down. A
 * port of `DEBUG_MARKS_LEGEND` and `DEBUG_MARKS_JS`.
 */
export function DebugMarks(): JSX.Element {
  useEffect(() => {
    const set = (on: boolean): void => {
      document.body.classList.toggle("debug-marks", on);
    };
    const down = (e: KeyboardEvent): void => {
      if (e.key === "Shift") set(true);
    };
    const up = (e: KeyboardEvent): void => {
      if (e.key === "Shift") set(false);
    };
    const away = (): void => set(false);
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", away);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", away);
      set(false);
    };
  }, []);
  return (
    <div id="debug-legend">
      <b>Hold Shift and hover a symbol to see why it is marked</b>
      <span>
        <i className="sw" style={{ borderColor: "var(--accent)" }} />
        <b>csite</b> — a call-graph edge, marked when the page was built
      </span>
      <span>
        <i className="sw" style={{ borderColor: "var(--add-edge)" }} />
        <b>sym</b> — the navigation server resolved it when clicked
      </span>
      <span>
        <i className="sw" style={{ borderColor: "#a855f7" }} />
        <b>decl</b> — a declaration the page knows (lights up in place)
      </span>
      <span>
        <i className="sw" style={{ borderColor: "var(--ink-faint)" }} />
        <b>id</b> — not asked yet, or unresolved with the reason
      </span>
    </div>
  );
}
