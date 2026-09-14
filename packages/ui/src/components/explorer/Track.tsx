import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import type { CallPathResult, FileIndex, PathNode, SliceInput } from "../../lib/callGraph.js";
import { defNames, knownPanel, panelFor, referencesFor } from "../../lib/nav.js";
import { resolveSpan, spanAt } from "../../lib/spans.js";
import { DefPanel } from "./DefPanel.js";
import { NodePanel } from "./NodePanel.js";
import { RefMenu, type RefMenuState } from "./RefMenu.js";
import { SlicePanel } from "./SlicePanel.js";

/** Where a clicked link sits, in terms a fresh copy of its panel can answer. */
export interface OriginDesc {
  row?: string | undefined;
  def?: string | null | undefined;
  target?: string | null | undefined;
  at?: { file: string; line: number; col: number } | undefined;
}

/** The mark a link opens onto in its destination: a call site, or a declaration. */
export interface DestDesc {
  site?: { file: string; line: number; col: number } | undefined;
  decl?: string | null | undefined;
}

export interface LinkDesc {
  from: number;
  fromDesc: OriginDesc;
  to: number;
  toDesc: DestDesc;
}

/** One waypoint of a walk, as the history trail records it. */
export interface NavStep {
  id: string;
  ids: string[];
  anchors: (DestDesc | null)[];
  link: LinkDesc | null;
  pos: number;
}

export type Restore = (ids: string[], pos: number, anchors: (DestDesc | null)[], link: LinkDesc | null) => Promise<void>;

/** What each panel on the track was opened for, so a rebuilt copy lands on the same mark. */
const anchorOf = new WeakMap<Element, DestDesc | null>();

export interface TrackProps {
  slice: SliceInput;
  sliceIndex: number;
  total: number;
  index: FileIndex;
  navBase: string;
  debug: boolean;
  /** Names of every graph node on the page, for the rails and the trail. */
  names: Record<string, string>;
  nodes: Map<string, { node: PathNode; graph: CallPathResult }>;
  onNavigate: (step: NavStep) => void;
  registerRestore: (slice: number, restore: Restore) => void;
}

/**
 * One slice's horizontal axis: a track of panels, two visible at a time,
 * with a rail on each edge for the panel just off screen. A port of
 * `initExplorer` — the track's composition is React state here, the marks
 * and the scrolling still DOM work.
 */
export function Track(props: TrackProps): JSX.Element {
  const { slice, sliceIndex, total, index, navBase, debug, names, nodes, onNavigate, registerRestore } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [ids, setIds] = useState<string[]>(["__slice__"]);
  const [pos, setPos] = useState(0);
  // True right after a walk up *replaces* whoever sits at the pin — a fresh,
  // un-drilled caller with no accumulated depth behind it.
  const [freshCaller, setFreshCaller] = useState(false);
  const [menu, setMenu] = useState<RefMenuState | null>(null);
  const idsRef = useRef(ids);
  const posRef = useRef(pos);
  const freshRef = useRef(freshCaller);
  const activeLink = useRef<{ origin: Element; originDesc: OriginDesc; dest: Element; destDesc: DestDesc } | null>(null);
  const linkGen = useRef(0);

  const nameOf = (id: string | undefined): string | undefined => (id === undefined ? undefined : (names[id] ?? defNames.get(id)));
  const nodeAt = (i: number): string | undefined => idsRef.current[i];

  /** The panel for an id exists (fetching it from the server if it never has). */
  const ensure = useCallback(
    async (id: string): Promise<boolean> => {
      if (id === "__slice__" || nodes.has(id)) return true;
      const known = knownPanel(id);
      if (known !== undefined) return known !== null;
      return (await panelFor(navBase, id)) !== null;
    },
    [nodes, navBase],
  );

  const setPosition = useCallback((p: number, animate: boolean): void => {
    const track = trackRef.current;
    if (!animate && track) track.classList.add("no-anim");
    posRef.current = p;
    flushSync(() => setPos(p));
    if (!animate && track) {
      void track.offsetWidth;
      track.classList.remove("no-anim");
    }
  }, []);

  const commit = useCallback((next: string[], fresh: boolean): void => {
    idsRef.current = next;
    freshRef.current = fresh;
    flushSync(() => {
      setIds(next);
      setFreshCaller(fresh);
    });
  }, []);

  const panelEl = (i: number): HTMLElement | null => (trackRef.current?.children[i] as HTMLElement | undefined) ?? null;

  /** Callee direction: append to the right of the tapped panel and slide left. */
  const walkDown = useCallback(
    async (id: string, fromIndex: number): Promise<HTMLElement | null> => {
      if (!(await ensure(id))) return null;
      const next = idsRef.current.slice(0, fromIndex + 1).concat([id]);
      commit(next, false);
      setPosition(Math.max(0, next.length - 2), true);
      return panelEl(next.length - 1);
    },
    [ensure, commit, setPosition],
  );

  /**
   * Caller direction: the caller slides in on the LEFT of the tapped panel
   * and the deck slides right, so the track always reads caller → callee.
   * The panels it displaces on that side were a different caller chain and
   * go; the pinned slice is the one that stays.
   */
  const walkUp = useCallback(
    async (id: string, fromIndex: number): Promise<HTMLElement | null> => {
      if (fromIndex > 0 && nodeAt(fromIndex - 1) === id) {
        setPosition(fromIndex - 1, true);
        return panelEl(fromIndex - 1);
      }
      if (!(await ensure(id))) return null;
      const next = [...idsRef.current];
      const slot = next.indexOf("__slice__");
      const anchor = slot >= 0 && slot < fromIndex ? slot + 1 : 0;
      const oldSlot = fromIndex - posRef.current;
      next.splice(anchor, fromIndex - anchor, id);
      commit(next, true);
      // The tapped panel is now the caller's pair partner on the right. If it
      // had been in the left slot, start the deck there so it visibly slides
      // across as the caller takes its place.
      if (oldSlot <= 0) {
        setPosition(anchor + 1, false);
        setPosition(anchor, true);
      } else {
        setPosition(anchor, false);
      }
      return panelEl(anchor);
    },
    [ensure, commit, setPosition],
  );

  const clearLinks = useCallback((): void => {
    linkGen.current++;
    activeLink.current = null;
    for (const old of rootRef.current?.querySelectorAll(".sym-link") ?? []) old.classList.remove("sym-link", "sym-dim");
  }, []);

  const applyLink = useCallback(
    (originPanel: Element, oDesc: OriginDesc, destPanel: Element, dDesc: DestDesc): void => {
      clearLinks();
      const clicked = originEls(originPanel, oDesc);
      for (const el of clicked) el.classList.add("sym-link");
      const dest = declEls(destPanel, dDesc);
      for (const el of dest) el.classList.add("sym-link", "sym-dim");
      const anchor = anchorEl(destPanel, dDesc);
      if (anchor && dDesc.site) anchor.classList.add("sym-link");
      if (anchor) revealInPanel(destPanel, anchor);
      activeLink.current = { origin: originPanel, originDesc: oDesc, dest: destPanel, destDesc: dDesc };
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          for (const el of clicked) el.classList.add("sym-dim");
        });
      });
    },
    [clearLinks],
  );

  const linkSymbols = useCallback(
    (link: HTMLElement, dest: HTMLElement): void => {
      const dDesc = destDesc(link);
      anchorOf.set(dest, dDesc);
      applyLink(link.closest(".panel") ?? rootRef.current!, originDesc(link), dest, dDesc);
    },
    [applyLink],
  );

  /**
   * Every action that lands the viewport on a node — walking, or paging the
   * rail to reveal one already on the track — reports it here; the history
   * list decides for itself whether that is new ground.
   */
  const report = useCallback(
    (id: string | undefined): void => {
      if (id === undefined) return;
      const children = [...(trackRef.current?.children ?? [])];
      let link: LinkDesc | null = null;
      const live = activeLink.current;
      if (live) {
        const from = children.indexOf(live.origin);
        const to = children.indexOf(live.dest);
        if (from >= 0 && to >= 0) link = { from, fromDesc: live.originDesc, to, toDesc: live.destDesc };
      }
      onNavigate({
        id,
        ids: [...idsRef.current],
        anchors: children.map((c) => anchorOf.get(c) ?? null),
        link,
        pos: posRef.current,
      });
    },
    [onNavigate],
  );

  /**
   * A symbol whose declaration is already on screen in the same pane: light
   * the pair up in place rather than opening a panel for what the reader can
   * already see. Sibling uses may still be plain `.id` spans, so the full
   * set comes from the server rather than from the DOM.
   */
  const linkInPlace = useCallback(
    (link: HTMLElement, decl: HTMLElement, defId: string): void => {
      clearLinks();
      const gen = linkGen.current;
      const scope = link.closest(".panel") ?? rootRef.current!;
      decl.classList.add("sym-link");
      void referencesFor(navBase, defId).then((refs) => {
        if (!refs || gen !== linkGen.current) return;
        for (const site of refs.sites) {
          const span = spanAt(scope, site.file, site.line, site.startColumn);
          if (span) span.classList.add("sym-link");
        }
      });
    },
    [clearLinks, navBase],
  );

  const openRefMenu = useCallback(
    (e: MouseEvent, sym: HTMLElement): void => {
      e.preventDefault();
      e.stopPropagation();
      const panel = sym.closest(".panel") as HTMLElement | null;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const left = e.clientX - rect.left + panel.scrollLeft;
      const top = e.clientY - rect.top + panel.scrollTop + 6;
      setMenu({ panel, left, top, defId: null, refs: null });
      // Always answer the gesture: a local or an unresolved symbol has no
      // callers to list, and silence reads as a broken shortcut.
      const known = sym.dataset.decl ?? sym.dataset.def;
      const idOf = known ? Promise.resolve(known) : resolveSpan(navBase, sym, debug).then((a) => a?.id ?? null);
      void idOf.then(async (id) => {
        const refs = id ? await referencesFor(navBase, id) : null;
        setMenu((current) =>
          current && current.panel === panel
            ? { ...current, defId: id, refs: refs ?? { kind: "calls", sites: [] } }
            : current,
        );
      });
    },
    [navBase, debug],
  );

  /** A resolved identifier: its declaration in view lights up in place; otherwise its panel slides in. */
  const openDefinition = useCallback(
    (link: HTMLElement, panel: HTMLElement, i: number, answer: { id: string; self: boolean; panelId: string; decl: { file: string; line: number; column: number } }): void => {
      const decl = spanAt(panel, answer.decl.file, answer.decl.line, answer.decl.column);
      if (decl && inView(panel, decl)) {
        linkInPlace(link, decl, answer.id);
        return;
      }
      if (answer.self) return;
      void walkDown(answer.panelId, i).then((dest) => {
        if (!dest) return;
        linkSymbols(link, dest);
        report(answer.panelId);
      });
    },
    [linkInPlace, walkDown, linkSymbols, report],
  );

  const click = (e: MouseEvent): void => {
    const target = e.target as Element;
    // Cmd-click (Ctrl-click elsewhere) on a symbol opens its callers menu;
    // a right-click would fight the browser's own menu.
    const sym = target.closest<HTMLElement>(".id, .self-sym, .csite");
    if ((e.metaKey || e.ctrlKey) && sym) {
      openRefMenu(e, sym);
      return;
    }
    const link = target.closest<HTMLElement>(".csite, .caller-row, .id");
    if (link) {
      const panel = link.closest<HTMLElement>(".panel");
      const i = panel ? [...(trackRef.current?.children ?? [])].indexOf(panel) : -1;
      if (i < 0 || !panel) return;
      if (link.classList.contains("caller-row")) {
        const to = link.dataset.target;
        if (!to) return;
        void walkUp(to, i).then((dest) => {
          if (!dest) return;
          // A row from the callers menu: the menu is gone once the caller
          // slides in, so the trail marker is the symbol the menu was opened
          // on and the destination is the call site inside the caller.
          linkSymbols(link, dest);
          if (link.dataset.refDef) setMenu(null);
          report(to);
        });
        return;
      }
      if (link.classList.contains("csite")) {
        const to = link.dataset.target;
        if (!to) return;
        void walkDown(to, i).then((dest) => {
          if (!dest) return;
          linkSymbols(link, dest);
          report(to);
        });
        return;
      }
      void resolveSpan(navBase, link, debug).then((answer) => {
        if (answer) openDefinition(link, panel, i, answer);
      });
      return;
    }
    if (target.closest(".rail-left")) {
      const backTo = Math.max(0, posRef.current - 1);
      setPosition(backTo, true);
      report(nodeAt(backTo));
    } else if (target.closest(".rail-right")) {
      const fwdTo = Math.min(idsRef.current.length - 2, posRef.current + 1);
      setPosition(fwdTo, true);
      report(nodeAt(fwdTo + 1));
    }
  };

  /**
   * Rebuild the track from a saved list of node ids and re-settle it at the
   * saved slot. A panel still on the track keeps the scroll the reader left
   * it at; one that was away is scrolled back to the anchor it was opened
   * for, and the highlighted pair is rebuilt from the same descriptors a
   * live walk records.
   */
  const restore = useCallback<Restore>(
    async (wanted, newPos, anchors, link) => {
      const kept: string[] = [];
      for (const id of wanted) if (await ensure(id)) kept.push(id);
      const onTrack = new Set(idsRef.current);
      commit(kept, freshRef.current);
      setPosition(Math.max(0, Math.min(newPos, kept.length - 2)), true);
      clearLinks();
      const children = [...(trackRef.current?.children ?? [])];
      children.forEach((el, i) => {
        anchorOf.set(el, anchors[i] ?? null);
        if (onTrack.has(kept[i]!)) return;
        const mark = anchorEl(el, anchors[i] ?? {});
        if (mark) revealInPanel(el, mark);
      });
      const from = link && children[link.from];
      const to = link && children[link.to];
      if (from && to && link) applyLink(from, link.fromDesc, to, link.toDesc);
    },
    [ensure, commit, setPosition, clearLinks, applyLink],
  );

  useEffect(() => {
    registerRestore(sliceIndex, restore);
  }, [registerRestore, sliceIndex, restore]);

  // Any click outside the menu, Escape, or a scroll dismisses it — a menu
  // that drifts away from its symbol is worse than none.
  useEffect(() => {
    if (!menu) return;
    const away = (e: Event): void => {
      if (!(e.target as Element).closest?.(".ref-menu")) setMenu(null);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("click", away);
    document.addEventListener("wheel", away, { passive: true });
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", away);
      document.removeEventListener("wheel", away);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  // Every lateral caller swap collapses back to beside the pinned slice, so
  // "behind" is the slice itself right after a caller pick — not a real
  // waypoint. Once a walk down has happened since, it is genuine depth.
  const behind = pos > 0 && (nodeAt(pos - 1) !== "__slice__" || !freshCaller);
  const forward = ids.length > pos + 2;
  const seen = new Map<string, number>();

  return (
    <div
      className={`viewport${behind ? " can-back" : ""}${forward ? " can-fwd" : ""}`}
      ref={rootRef}
      onClick={click}
    >
      <button className="rail rail-left">{behind ? `◀ ${nameOf(ids[pos - 1]) ?? "back"}` : ""}</button>
      <button className="rail rail-right">{forward ? `${nameOf(ids[pos + 2]) ?? "forward"} ▶` : ""}</button>
      <div className="track" ref={trackRef} style={{ ["--pos" as string]: String(pos) }}>
        {ids.map((id) => {
          const nth = seen.get(id) ?? 0;
          seen.set(id, nth + 1);
          const key = `${id}#${nth}`;
          if (id === "__slice__") {
            return <SlicePanel key={key} slice={slice} rank={sliceIndex + 1} total={total} index={index} debug={debug} />;
          }
          const found = nodes.get(id);
          if (found) return <NodePanel key={key} node={found.node} graph={found.graph} index={index} debug={debug} />;
          const answer = knownPanel(id);
          return answer ? <DefPanel key={key} id={id} html={answer.html} /> : null;
        })}
      </div>
      {menu && <RefMenu state={menu} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Marks

function originDesc(link: HTMLElement): OriginDesc {
  if (link.classList.contains("caller-row")) {
    return link.dataset.refDef ? { def: link.dataset.refDef } : { row: link.dataset.target };
  }
  const desc: OriginDesc = { target: link.dataset.target ?? null, def: link.dataset.def ?? null };
  const row = link.closest(".line");
  const pane = link.closest<HTMLElement>(".code-pane");
  const lineno = row?.querySelector(".lineno");
  const line = lineno ? parseInt(lineno.textContent ?? "", 10) : NaN;
  if (pane?.dataset.file && line > 0 && row) {
    const range = document.createRange();
    range.setStartAfter(lineno!);
    range.setEndBefore(link);
    desc.at = { file: pane.dataset.file, line, col: range.toString().length };
  }
  return desc;
}

function destDesc(link: HTMLElement): DestDesc {
  if (link.classList.contains("caller-row") && link.dataset.refDef) {
    return {
      site: { file: link.dataset.refFile!, line: Number(link.dataset.refLine), col: Number(link.dataset.refCol) },
    };
  }
  return { decl: link.dataset.def ?? null };
}

function cssEscape(id: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
}

function originEls(panel: Element, d: OriginDesc): Element[] {
  if (d.row) {
    const row = panel.querySelector(`.caller-row[data-target="${cssEscape(d.row)}"]`);
    return row ? [row.querySelector(".fn-name") ?? row] : [];
  }
  let found: Element[] = [];
  if (d.def) {
    found = [...panel.querySelectorAll(`.sym[data-def="${cssEscape(d.def)}"], .self-sym[data-decl="${cssEscape(d.def)}"]`)];
  }
  if (!found.length && d.target) {
    found = [...panel.querySelectorAll(`.csite[data-target="${cssEscape(d.target)}"], .sym[data-target="${cssEscape(d.target)}"]`)];
  }
  if (!found.length && d.at) {
    const span = spanAt(panel, d.at.file, d.at.line, d.at.col);
    if (span) found = [span];
  }
  return found;
}

/**
 * The declaration marks a destination descriptor names. A function panel
 * has one self-sym; a definition panel may show several, so prefer the one
 * tagged with the link's definition id.
 */
function declEls(panel: Element, d: DestDesc): Element[] {
  const tagged = d.decl ? panel.querySelector(`.self-sym[data-decl="${cssEscape(d.decl)}"]`) : null;
  return tagged ? [tagged] : [...panel.querySelectorAll(".self-sym")];
}

/** The one element a panel scrolls to for its anchor. */
function anchorEl(panel: Element, d: DestDesc): Element | null {
  if (d.site) return spanAt(panel, d.site.file, d.site.line, d.site.col);
  return declEls(panel, d)[0] ?? null;
}

/**
 * A panel opens at the top of the region it renders, but the declaration
 * asked for can sit far below that. Scroll it into the panel's own
 * scrollport, a third of the way down, and leave a panel that already shows
 * it where the reader left it.
 */
function revealInPanel(panel: Element, el: Element): void {
  const p = panel.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (!p.height || !r.height) return;
  if (r.top >= p.top && r.bottom <= p.bottom) return;
  const scroller = panel as HTMLElement;
  const offset = r.top - p.top + scroller.scrollTop;
  const max = scroller.scrollHeight - scroller.clientHeight;
  scroller.scrollTop = Math.max(0, Math.min(offset - scroller.clientHeight / 3, max));
}

/** Is the element fully inside the panel's scrollport? */
function inView(panel: Element, el: Element): boolean {
  const p = panel.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.top >= p.top && r.bottom <= p.bottom && r.height > 0;
}
