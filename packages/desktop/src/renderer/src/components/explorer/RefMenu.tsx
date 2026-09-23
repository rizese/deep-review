import { useLayoutEffect, useRef, type JSX } from "react";
import { createPortal } from "react-dom";
import type { ReferenceList } from "../../lib/callGraph.js";

export interface RefMenuState {
  /** The panel the menu is placed inside, so it scrolls with the code. */
  panel: HTMLElement;
  left: number;
  top: number;
  defId: string | null;
  refs: ReferenceList | null;
}

/**
 * The cmd-click menu of who calls (or, for a class or constant, who
 * references) a symbol. Its rows are caller-rows, so the track's click
 * handler walks up into the caller exactly as a panel's own called-by rows
 * do. A port of `openRefMenu`.
 */
export function RefMenu({ state }: { state: RefMenuState }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const { panel, top, left, refs, defId } = state;

  // Pulled back inside the pane if it would spill out; the width is only
  // known once the rows are laid out, so this runs after every render.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const clamped = Math.max(0, Math.min(left, panel.scrollLeft + panel.clientWidth - menu.offsetWidth - 8));
    menu.style.left = `${clamped}px`;
  }, [panel, left, refs]);

  return createPortal(
    <div className="ref-menu" ref={ref} style={{ left, top }}>
      {refs === null ? (
        <>
          <div className="call-sites-label">callers</div>
          <div className="ref-more">resolving…</div>
        </>
      ) : (
        <>
          <div className="call-sites-label">{refs.kind === "calls" ? "called by" : "referenced by"}</div>
          {refs.sites.length === 0 && <div className="ref-more">no callers found</div>}
          {refs.sites.map((site, i) => (
            <button
              key={`${site.file}:${site.line}:${site.startColumn}:${i}`}
              className="caller-row"
              {...(site.panelId ? { "data-target": site.panelId } : { disabled: true })}
              data-ref-def={defId ?? ""}
              data-ref-file={site.file}
              data-ref-line={site.line}
              data-ref-col={site.startColumn}
            >
              ↖ <code className="fn-name">{site.enclosingName}</code> <span className="loc">L{site.line}</span>
              {site.indirect && (
                <span className="ref-tag" title="passed as a value, not called here">
                  passed
                </span>
              )}{" "}
              <code>{site.snippet}</code>
            </button>
          ))}
        </>
      )}
    </div>,
    panel,
  );
}
