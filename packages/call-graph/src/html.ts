import {
  escapeHtml as esc,
  identifierMarks,
  identifiersOf,
  languageOf,
  renderLine,
  tokenizeLines,
  type IdentifierToken,
  type Language,
  type Mark,
  type Token,
} from "./highlight.js";
import type {
  DiffHunk,
  EmbeddedFile,
  RelatedFunction,
  SymbolRange,
} from "./types.js";

/** Lines revealed per click of an expander, matching GitHub. */
const EXPAND_STEP = 20;

// ---------------------------------------------------------------------------
// Embedded file index

export interface FileEntry {
  key: string;
  lang: Language;
  lines: string[];
  tokens: Token[][];
  /** Identifier spans per line, scanned over the whole file so a word inside
   *  a multi-line string or comment is never one. */
  ids: IdentifierToken[][];
  /**
   * The base rendering of each line: syntax tokens plus a bare `.id` span on
   * every identifier. This exact string is what the page's expander inserts
   * for the line and what a pane shows for any row it does not decorate, so
   * a row reads — and navigates — the same whether it was rendered here or
   * revealed later.
   */
  html: string[];
  symbols: SymbolRange[];
  /** Debug builds: the baked `.id` spans say they have not been asked yet. */
  debug: boolean;
}

export type FileIndex = Map<string, FileEntry>;

export interface FileIndexOptions {
  /** Debug builds: every `.id` span explains itself (`data-why`). */
  debug?: boolean | undefined;
}

export function buildFileIndex(files: EmbeddedFile[], options: FileIndexOptions = {}): FileIndex {
  const debug = options.debug ?? false;
  const index: FileIndex = new Map();
  for (const file of files) {
    const key = `${file.side}:${file.path}`;
    const lang = languageOf(file.path);
    const tokens = tokenizeLines(file.lines, lang);
    const ids = identifiersOf(file.lines, lang);
    index.set(key, {
      key,
      lang,
      lines: file.lines,
      tokens,
      ids,
      html: file.lines.map((line, i) => lineHtml(line, tokens[i]!, ids[i]!, [], debug)),
      symbols: file.symbols,
      debug,
    });
  }
  return index;
}

function lineHtml(
  text: string,
  tokens: readonly Token[],
  ids: readonly IdentifierToken[],
  marks: readonly Mark[],
  debug: boolean,
): string {
  return renderLine(text, tokens, [...marks, ...identifierMarks(ids, marks, debug)]);
}

/**
 * Head line `n` of an embedded file with a pane's marks layered in; an
 * identifier a mark covers keeps the mark's span rather than gaining an
 * `.id`. With no marks this is the base rendering itself, `entry.html[n-1]`.
 * A line outside the file renders as nothing, as the expander does.
 */
export function fileLineHtml(entry: FileEntry, n: number, marks: readonly Mark[] = []): string {
  const i = n - 1;
  if (i < 0 || i >= entry.lines.length) return "";
  if (!marks.length) return entry.html[i]!;
  return lineHtml(entry.lines[i]!, entry.tokens[i]!, entry.ids[i]!, marks, entry.debug);
}

function symbolLabel(symbol: SymbolRange): string {
  return ["class", "interface", "enum", "namespace"].includes(symbol.kind)
    ? `${symbol.kind} ${symbol.name}`
    : `${symbol.name}()`;
}

/** Outermost → innermost declarations containing a line, following the symbol tree. */
export function scopeChainFor(symbols: readonly SymbolRange[], line: number): SymbolRange[] {
  const chain: SymbolRange[] = [];
  let level: readonly SymbolRange[] = symbols;
  for (;;) {
    const hit = level.find((s) => s.startLine <= line && s.endLine >= line);
    if (!hit) return chain;
    chain.push(hit);
    level = hit.children ?? [];
  }
}

/** Breadcrumb on expanders: "class Ky › #retry()". */
function crumbFor(symbols: readonly SymbolRange[], line: number): string {
  return scopeChainFor(symbols, line)
    .map((s) => esc(symbolLabel(s)))
    .join(" › ");
}

/** Sticky-header label: "Ky.#retry" — the chain of names, dotted. */
export function scopeLabelFor(symbols: readonly SymbolRange[], line: number): string {
  return scopeChainFor(symbols, line)
    .map((s) => s.name)
    .join(".");
}

// ---------------------------------------------------------------------------
// Code blocks: line rows, expander gaps

export interface LineDecoration {
  /** Extra classes on the row, e.g. ["hl"] or ["diff-add"]. */
  cls?: string[];
  marks?: Mark[];
  /** PR-removed line texts rendered (red, "−" gutter) above this line. */
  deletedBefore?: string[];
}

export type Decorations = Map<number, LineDecoration>;

export function lineRow(
  lineNumber: number | string,
  width: number,
  contentHtml: string,
  cls: string[] = [],
): string {
  const classes = ["line", ...cls].join(" ");
  return `<span class="${classes}"><span class="lineno">${String(lineNumber).padStart(width)}</span>${contentHtml}</span>`;
}

/** A gap bar with nothing to expand into: the file's text is not on the page. */
export function staticGapRow(count: number): string {
  if (count <= 0) return "";
  return `<div class="gap static"><span class="gap-count">⋯ ${count} hidden lines</span></div>`;
}

/** GitHub-style expander: ▲ reveals the gap's bottom, ▼ its top. */
export function gapRow(entry: FileEntry, from: number, to: number): string {
  const count = to - from + 1;
  if (count <= 0) return "";
  const crumb = crumbFor(entry.symbols, Math.min(to + 1, entry.lines.length));
  const buttons =
    count <= EXPAND_STEP
      ? '<button class="gap-btn gap-all" title="Expand all">↕</button>'
      : '<button class="gap-btn gap-up" title="Expand up">▲</button><button class="gap-btn gap-down" title="Expand down">▼</button>';
  return `<div class="gap" data-key="${esc(entry.key)}" data-from="${from}" data-to="${to}"><span class="gap-btns">${buttons}</span><span class="gap-count">⋯ ${count} hidden lines</span>${
    crumb ? `<span class="gap-crumb">${crumb}</span>` : ""
  }</div>`;
}


// ---------------------------------------------------------------------------
// Presence badge

export function presenceBadge(
  fn: Pick<RelatedFunction, "presence" | "changedInPr" | "renamedFrom">,
): string {
  if (fn.renamedFrom) {
    return `<span class="badge renamed">renamed from ${esc(fn.renamedFrom)}</span>`;
  }
  if (fn.presence === "both") {
    return fn.changedInPr
      ? '<span class="badge changed">changed</span>'
      : '<span class="badge">unchanged</span>';
  }
  return `<span class="badge ${fn.presence === "after" ? "added" : "removed"}">${
    fn.presence === "after" ? "added in PR" : "removed in PR"
  }</span>`;
}

// ---------------------------------------------------------------------------
// Page chrome: CSS, embedded data, client JS

export const CSS = `
  :root {
    /* The pool is light blue by default; the bar's switcher stamps data-theme
       on the root to override the OS, and "system" removes it again. */
    color-scheme: light;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
    /* The pool: light blue water, and glass on top of it. Panels are
       translucent white so the gradient and its grain read through them. */
    --pool: linear-gradient(160deg, #b3daf1 0%, #86bfe3 42%, #6fb0da 100%);
    --grain: 0.36;
    --bg: #8ec4e6; --panel: rgba(255, 255, 255, 0.74); --panel-2: rgba(255, 255, 255, 0.5);
    --ink: #0f2b45; --ink-soft: #35597a; --ink-faint: #6d92b0;
    --line-c: rgba(15, 60, 95, 0.16);
    --glass-hi: rgba(255, 255, 255, 0.42); --glass-lo: rgba(255, 255, 255, 0.16);
    --glass-edge: rgba(255, 255, 255, 0.8); --glass-shadow: rgba(15, 60, 95, 0.18);
    --wordmark: #ffffff; --pressed-bg: #0f2b45; --pressed-ink: #ffffff;
    --scroll-thumb: rgba(15, 43, 69, 0.22); --scroll-thumb-hover: rgba(15, 43, 69, 0.4);
    --accent: #0b63b8; --accent-ink: #ffffff; --accent-soft: rgba(11, 99, 184, 0.12);
    --add-bg: rgba(22, 163, 74, 0.10); --add-edge: #15803d;
    --del-bg: rgba(220, 38, 38, 0.09); --del-edge: #c92a2a;
    --callsite-bg: rgba(11, 99, 184, 0.12);
    --add-inner: rgba(22, 163, 74, 0.28); --del-inner: rgba(220, 38, 38, 0.26);
    --tok-kw: #7e22ce; --tok-str: #15803d; --tok-com: #6d92b0;
    --tok-num: #b45309; --tok-fn: #0b63b8; --tok-type: #0e7490; --tok-lit: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      /* The same pool at night: deep water, panels a breath of light over it. */
      color-scheme: dark;
      --pool: linear-gradient(160deg, #0d2f46 0%, #0b3a55 48%, #072538 100%);
      --grain: 0.22;
      --bg: #0b3550; --panel: rgba(255, 255, 255, 0.075); --panel-2: rgba(255, 255, 255, 0.05);
      --ink: #e6f1f8; --ink-soft: #9fbdd3; --ink-faint: #6f91a8;
      --line-c: rgba(255, 255, 255, 0.13);
      --glass-hi: rgba(255, 255, 255, 0.16); --glass-lo: rgba(255, 255, 255, 0.05);
      --glass-edge: rgba(255, 255, 255, 0.32); --glass-shadow: rgba(0, 10, 20, 0.4);
      --wordmark: #ffffff; --pressed-bg: #ffffff; --pressed-ink: #0f2b45;
      --scroll-thumb: rgba(230, 241, 248, 0.2); --scroll-thumb-hover: rgba(230, 241, 248, 0.38);
      --accent: #7cc4f0; --accent-ink: #06202f; --accent-soft: rgba(124, 196, 240, 0.16);
      --add-bg: rgba(74, 222, 128, 0.09); --add-edge: #4ade80;
      --del-bg: rgba(248, 113, 113, 0.09); --del-edge: #f87171;
      --callsite-bg: rgba(124, 196, 240, 0.16);
      --add-inner: rgba(74, 222, 128, 0.28); --del-inner: rgba(248, 113, 113, 0.26);
      --tok-kw: #c084fc; --tok-str: #86efac; --tok-com: #6f91a8;
      --tok-num: #fbbf24; --tok-fn: #a5d8fa; --tok-type: #67e8f9; --tok-lit: #fbbf24;
    }
  }
  :root[data-theme="dark"] {
    /* The same pool at night: deep water, panels a breath of light over it. */
    color-scheme: dark;
    --pool: linear-gradient(160deg, #0d2f46 0%, #0b3a55 48%, #072538 100%);
    --grain: 0.22;
    --bg: #0b3550; --panel: rgba(255, 255, 255, 0.075); --panel-2: rgba(255, 255, 255, 0.05);
    --ink: #e6f1f8; --ink-soft: #9fbdd3; --ink-faint: #6f91a8;
    --line-c: rgba(255, 255, 255, 0.13);
    --glass-hi: rgba(255, 255, 255, 0.16); --glass-lo: rgba(255, 255, 255, 0.05);
    --glass-edge: rgba(255, 255, 255, 0.32); --glass-shadow: rgba(0, 10, 20, 0.4);
    --wordmark: #ffffff; --pressed-bg: #ffffff; --pressed-ink: #0f2b45;
      --scroll-thumb: rgba(230, 241, 248, 0.2); --scroll-thumb-hover: rgba(230, 241, 248, 0.38);
    --accent: #7cc4f0; --accent-ink: #06202f; --accent-soft: rgba(124, 196, 240, 0.16);
    --add-bg: rgba(74, 222, 128, 0.09); --add-edge: #4ade80;
    --del-bg: rgba(248, 113, 113, 0.09); --del-edge: #f87171;
    --callsite-bg: rgba(124, 196, 240, 0.16);
    --add-inner: rgba(74, 222, 128, 0.28); --del-inner: rgba(248, 113, 113, 0.26);
    --tok-kw: #c084fc; --tok-str: #86efac; --tok-com: #6f91a8;
    --tok-num: #fbbf24; --tok-fn: #a5d8fa; --tok-type: #67e8f9; --tok-lit: #fbbf24;
  }
  /* Scrollbars out of the way: thin, no track, a thumb in the page's own ink
     that firms up under the pointer. The standard properties cover Chrome,
     Edge, Firefox and Safari 18; where a platform draws overlay scrollbars
     of its own, they stay overlay. */
  * { scrollbar-width: thin; scrollbar-color: var(--scroll-thumb) transparent; }
  *:hover { scrollbar-color: var(--scroll-thumb-hover) transparent; }
  .tok-kw { color: var(--tok-kw); } .tok-str { color: var(--tok-str); }
  .tok-com { color: var(--tok-com); font-style: italic; } .tok-num { color: var(--tok-num); }
  .tok-fn { color: var(--tok-fn); } .tok-type { color: var(--tok-type); }
  .tok-lit { color: var(--tok-lit); }
  body { margin: 0 auto; padding: 1.5rem 1rem 4rem; background: var(--bg); color: var(--ink);
         font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  code { font-family: var(--mono); font-size: 0.9em; }
  header h1 { margin-bottom: 0.2rem; letter-spacing: -0.015em; }
  header .meta { color: var(--ink-soft); font-size: 0.9rem; }
  header a { color: inherit; }
  .count { color: var(--ink-faint); font-size: 0.8em; }
  details.fn { border: 1px solid var(--line-c); border-radius: 8px; margin: 0.5rem 0; background: var(--panel); }
  details.fn summary { padding: 0.5rem 0.8rem; cursor: pointer; display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; }
  details.fn .fn-name { font-weight: 700; }
  details.fn .fn-file { color: var(--ink-faint); }
  .badge { font-size: 0.68rem; font-weight: 500; padding: 0.14rem 0.55rem; border-radius: 999px;
           background: var(--panel-2); color: var(--ink-soft); border: 1px solid var(--line-c);
           font-variant-numeric: tabular-nums; }
  .badge.changed { background: rgba(230, 160, 0, 0.14); color: var(--tok-num); border-color: transparent; }
  .badge.renamed { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .badge.added { background: var(--add-bg); color: var(--add-edge); border-color: transparent; }
  .badge.removed { background: var(--del-bg); color: var(--del-edge); border-color: transparent; }
  .call-sites-label { font-size: 0.7rem; text-transform: uppercase; color: var(--ink-faint); margin-top: 0.4rem; }
  .loc { color: var(--ink-faint); font-size: 0.8em; }
  .missing { color: var(--ink-faint); font-style: italic; }
  pre.source { overflow-x: auto; background: var(--panel); border: 1px solid var(--line-c); border-radius: 8px; padding: 0.35rem 0; margin: 0.5rem 0 0.2rem; line-height: 1.65; font-family: var(--mono); font-size: 0.78rem; }
  /* Row backgrounds (diff tint, highlight, focus edge) must reach past the
     visible edge into the horizontally-scrolled part of a long line. The
     pre scrolls its content but stays the pane's width, so a row sized to
     it (100%) only covers what's on screen at load. .lines shrink-wraps
     to the widest row instead (inline-block, floored at 100%), and each
     block-level row then fills that — the true scrollable width. */
  .source .lines { display: inline-block; min-width: 100%; }
  .source .line { display: block; padding: 0 0.9rem; }
  .source .lineno { display: inline-block; color: var(--ink-faint); margin-right: 1.1rem; user-select: none; white-space: pre; }
  /* Markdown panes: wrap long lines instead of scrolling, with a hanging
     indent so wrapped text lines up under the content column rather than
     the gutter — the --gutter custom property (digit width of the
     line-number column) is set per pane since it varies with the file's
     line count. */
  pre.source.wrap { white-space: pre-wrap; overflow-x: hidden; }
  .source.wrap .line { position: relative; overflow-wrap: anywhere; padding-left: calc(0.9rem + var(--gutter, 0) * 1ch + 1.1rem); text-indent: calc(-1 * (var(--gutter, 0) * 1ch + 1.1rem)); }
  /* text-indent is inherited, so without a reset here the negative indent
     above applies a second time inside the lineno's own box — an
     inline-block starts a new block container, so this is not automatic —
     pushing its digits past the pane's clipped edge. The explicit width
     matters too: an auto-width inline-block's shrink-to-fit sizing breaks
     under a negative ancestor indent and resolves to 0. */
  .source.wrap .lineno { width: calc(var(--gutter, 0) * 1ch); text-indent: 0; }
  /* A small glyph in the gutter at the start of each visual row a wrapped
     line continues onto (not the line's first row) — the same spot a line
     number sits, so a reader scanning the gutter isn't surprised by text
     that isn't where the line count suggested it would be. Positioned per
     row by WRAP_JS, since that depends on the pane's rendered width.
     Generated content, so it never ends up in a copy-pasted selection. */
  .wrap-tick {
    /* The line numbers are right-padded (padStart), so a single-digit
       number sits flush against the gutter's right edge, not centered in
       it — matching that (rather than centering in the full gutter width)
       is what actually lines the tick up with the numbers above and
       below it. */
    position: absolute; left: 0.9rem; width: calc(var(--gutter, 0) * 1ch); text-align: right;
    text-indent: 0; color: var(--ink-faint); font-family: var(--mono); line-height: 1;
    user-select: none; pointer-events: none;
  }
  .wrap-tick::before { content: "↳"; }
  .source .line.hl { background: rgba(230,160,0,0.12); }
  .source .line.diff-add { background: var(--add-bg); }
  .source .line.diff-del { background: var(--del-bg); }
  .source .line.diff-del .lineno { color: var(--del-edge); }
  .source .line.diff-add .lineno { color: var(--add-edge); }
  /* Within a changed pair of lines, the words that actually differ. */
  .source .diff-add-inner { background: var(--add-inner); border-radius: 2px; }
  .source .diff-del-inner { background: var(--del-inner); border-radius: 2px; }
  /* The declaration a panel is about, marked along its left edge so it stands
     out from the context around it without competing with the diff colors. */
  .source .line.in-focus { box-shadow: inset 3px 0 0 var(--accent); }
  .source .line.elide { color: var(--ink-faint); font-style: italic; }
  .callsite { background: var(--callsite-bg); border-radius: 4px; padding: 0.05rem 0; }
  .csite { color: var(--accent); background: var(--callsite-bg); border-radius: 4px;
           padding: 0.08em 0.25em; cursor: pointer; transition: background 0.12s; }
  .csite:hover { background: var(--accent); }
  .csite:hover, .csite:hover * { color: var(--accent-ink); }
  .csite.active { outline: 2px solid var(--accent); }
  .gap { display: flex; align-items: center; gap: 0.8rem; background: var(--panel-2);
         border-top: 1px solid var(--line-c); border-bottom: 1px solid var(--line-c);
         padding: 0.22rem 0.9rem; font-family: ui-sans-serif, system-ui, sans-serif;
         font-size: 0.68rem; color: var(--ink-faint); }
  .gap.static { cursor: default; }
  /* Sticky scope header: the file, and the declaration the first visible
     line is in, pinned to the top of the pane as it scrolls. */
  /* No overflow clipping on the pane: it would make the pane the sticky
     header's scroll root instead of the panel. The bar and pre round their
     own corners. */
  /* Folding a pane is one transition of the source's max-height between 0
     and its measured height (--pane-h, set by SCOPE_JS on each click), so
     closing and opening are the same motion run in opposite directions.
     Border-box, so the cap at 0 takes the padding and border with it. */
  .code-pane { position: relative; margin: 0.5rem 0 0.9rem; }
  .scope-bar {
    /* .panel's own padding (0.7rem 0.9rem) would otherwise leave a gap
       above the bar once it sticks. Breaking out with a matching negative
       margin/top pins it flush to the panel edge instead; the padding
       below restores the usual text inset. Square on top since it now
       sits at the panel's true edge, not floating mid-content. */
    position: sticky; top: -0.7rem; z-index: 2; display: flex; align-items: baseline; gap: 0.15rem;
    margin: -0.7rem -0.9rem 0; padding: 0.4rem 0.9rem; background: var(--panel-2);
    /* 8px, like every panel and pane: the bar's top corners meet the panel's
       own rounded corners when it sticks, and the source's rounded bottom
       when it does not. Folded, all four corners round. */
    border: 1px solid var(--line-c); border-bottom: 1px solid transparent; border-radius: 8px 8px 0 0;
    font-family: var(--mono); font-size: 0.72rem; white-space: nowrap; overflow: hidden;
    cursor: pointer; user-select: none;
    transition: border-radius 0.3s cubic-bezier(0.32, 0.72, 0, 1), border-bottom-color 0.3s ease;
  }
  .scope-bar:hover { background: var(--accent-soft); }
  .code-pane.collapsed .scope-bar { border-bottom-color: var(--line-c); border-radius: 8px; }
  .scope-bar .scope-caret { display: inline-flex; align-self: center; margin-right: 0.3rem; color: var(--ink-faint); }
  .scope-bar .scope-caret svg {
    width: 0.8rem; height: 0.8rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
    transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
  }
  .code-pane.collapsed .scope-caret svg { transform: rotate(-90deg); }
  .scope-bar .scope-path { color: var(--ink-faint); overflow: hidden; text-overflow: ellipsis; }
  .scope-bar .scope-path .name { color: var(--ink); font-weight: 600; }
  .scope-bar .scope-sym { color: var(--ink); font-weight: 600; }
  .scope-bar .scope-sym:not(:empty)::before { content: ":"; color: var(--ink-faint); font-weight: 400; }
  .scope-bar .stat { margin-left: auto; padding-left: 0.8rem; font-size: 0.68rem; font-variant-numeric: tabular-nums; }
  .scope-bar .plus { color: var(--add-edge); }
  .scope-bar .minus { color: var(--del-edge); margin-left: 0.4rem; }
  .code-pane > pre.source {
    margin: 0; border-top-left-radius: 0; border-top-right-radius: 0;
    box-sizing: border-box; overflow-y: hidden;
    max-height: var(--pane-h, none);
    /* One curve and one duration for every property that moves, so the
       fold reads as a single motion and its reverse is the same motion. */
    transition: max-height 0.3s cubic-bezier(0.32, 0.72, 0, 1), padding 0.3s cubic-bezier(0.32, 0.72, 0, 1),
      border-width 0.3s cubic-bezier(0.32, 0.72, 0, 1);
  }
  /* Folded to nothing: the padding and border go too, or a sliver of pane
     and its horizontal scrollbar would stay under the bar. */
  .code-pane.collapsed > pre.source {
    max-height: 0; padding-top: 0; padding-bottom: 0; border-top-width: 0; border-bottom-width: 0; overflow: hidden;
  }
  .gap-btns { display: inline-flex; align-items: center; gap: 2px; }
  .gap-btn { border: none; background: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 0.7rem; line-height: 1; padding: 0.05rem 0.3rem; border-radius: 4px; }
  .gap-btn:hover { background: var(--accent-soft); }
  .gap-count { color: var(--ink-faint); }
  .gap-crumb { color: var(--ink-soft); font-family: var(--mono); margin-left: auto; }
`;

/** Expander behavior shared by all layouts. Written injection-safe (no template literals). */
export const GAP_JS = `
  var RD = JSON.parse(document.getElementById("render-data").textContent);
  var STEP = RD.step;
  /* Outermost → innermost symbols containing a line, down the symbol tree. */
  function scopeChain(file, line) {
    var chain = [], level = file.symbols;
    for (;;) {
      var hit = null;
      for (var i = 0; i < level.length; i++) {
        if (level[i].s <= line && level[i].e >= line) { hit = level[i]; break; }
      }
      if (!hit) return chain;
      chain.push(hit);
      level = hit.c || [];
    }
  }
  function crumbFor(file, line) {
    return scopeChain(file, line).map(function (s) { return s.l; }).join(" \\u203a ");
  }
  function scopeLabel(file, line) {
    return scopeChain(file, line).map(function (s) { return s.n; }).join(".");
  }
  function rowHtml(file, n, w) {
    var num = String(n); while (num.length < w) num = " " + num;
    return '<span class="line"><span class="lineno">' + num + "</span>" + (file.html[n - 1] || "") + "</span>";
  }
  function gapInner(file, from, to) {
    var count = to - from + 1;
    var buttons = count <= STEP
      ? '<button class="gap-btn gap-all" title="Expand all">\\u2195</button>'
      : '<button class="gap-btn gap-up" title="Expand up">\\u25b2</button><button class="gap-btn gap-down" title="Expand down">\\u25bc</button>';
    var crumb = crumbFor(file, Math.min(to + 1, file.count));
    return '<span class="gap-btns">' + buttons + '</span><span class="gap-count">\\u22ef ' + count + " hidden lines</span>" +
      (crumb ? '<span class="gap-crumb">' + crumb + "</span>" : "");
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".gap-btn");
    if (!btn) return;
    var gap = btn.closest(".gap");
    var file = RD.files[gap.dataset.key];
    if (!file) return;
    var from = Number(gap.dataset.from), to = Number(gap.dataset.to);
    var w = Number(gap.closest("pre").dataset.w);
    var rows = "";
    if (btn.classList.contains("gap-all") || to - from + 1 <= STEP) {
      for (var n = from; n <= to; n++) rows += rowHtml(file, n, w);
      gap.insertAdjacentHTML("beforebegin", rows);
      gap.remove();
      return;
    }
    if (btn.classList.contains("gap-down")) {
      for (var n2 = from; n2 < from + STEP; n2++) rows += rowHtml(file, n2, w);
      gap.insertAdjacentHTML("beforebegin", rows);
      from += STEP;
    } else {
      for (var n3 = to - STEP + 1; n3 <= to; n3++) rows += rowHtml(file, n3, w);
      gap.insertAdjacentHTML("afterend", rows);
      to -= STEP;
    }
    gap.dataset.from = String(from);
    gap.dataset.to = String(to);
    gap.innerHTML = gapInner(file, from, to);
    if (window.updateScopeBars) updateScopeBars(gap.closest(".panel, .col") || document);
    if (window.markWraps) markWraps(gap.closest("pre.source.wrap"));
  });
`;

/**
 * Marks each visual row a wrapped line of a markdown pane continues onto
 * with a small tick (.wrap-tick) at its start. Wrapping depends on the
 * pane's rendered width, so panes are watched with a ResizeObserver rather
 * than measured once — a window resize or newly expanded gap both change
 * it. Panels are cloned into the page at runtime (nav clicks, restored
 * history), so new panes are picked up via a MutationObserver rather than
 * a one-time querySelectorAll at load.
 */
export const WRAP_JS = `
  function markWraps(pre) {
    if (!pre) return;
    var lineHeight = parseFloat(getComputedStyle(pre).lineHeight);
    if (!lineHeight) return;
    var lines = pre.querySelectorAll(".line");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var ticks = line.querySelectorAll(".wrap-tick");
      for (var t = 0; t < ticks.length; t++) ticks[t].remove();
      var rows = Math.round(line.getBoundingClientRect().height / lineHeight);
      for (var r = 1; r < rows; r++) {
        var tick = document.createElement("span");
        tick.className = "wrap-tick";
        tick.style.top = (r * lineHeight) + "px";
        line.appendChild(tick);
      }
    }
  }
  var wrapObserver = window.ResizeObserver
    ? new ResizeObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) markWraps(entries[i].target);
      })
    : null;
  function watchWraps(root) {
    var pres = root.matches && root.matches("pre.source.wrap") ? [root] : root.querySelectorAll("pre.source.wrap");
    for (var i = 0; i < pres.length; i++) {
      if (wrapObserver) wrapObserver.observe(pres[i]);
      else markWraps(pres[i]);
    }
  }
  watchWraps(document);
  new MutationObserver(function (mutations) {
    for (var m = 0; m < mutations.length; m++) {
      var added = mutations[m].addedNodes;
      for (var n = 0; n < added.length; n++) {
        if (added[n].nodeType === 1) watchWraps(added[n]);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
`;

/**
 * The sticky scope header over each code pane: as the pane scrolls, it names
 * the declaration the first visible line sits in, the way GitHub pins the
 * enclosing hunk header. Panels are cloned at runtime, so the listener is
 * one capturing document-level scroll handler rather than one per pane.
 */
export const SCOPE_JS = `
  /* Head line of the first row not scrolled under the bar: binary search
     over the rows and gaps, in document order. Rows sit inside .lines (an
     inline-block wrapper so a row's background can span a horizontally-
     scrolled line's full width) rather than directly under the pre. */
  function firstVisibleLine(bar, pre) {
    var limit = bar.getBoundingClientRect().bottom;
    var kids = (pre.querySelector(".lines") || pre).children, lo = 0, hi = kids.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (kids[mid].getBoundingClientRect().bottom > limit) { found = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    for (var i = Math.max(found, 0); i < kids.length; i++) {
      var el = kids[i];
      if (el.classList.contains("gap")) return Number(el.dataset.from);
      var no = el.querySelector(".lineno");
      var n = no ? Number(no.textContent) : NaN;
      if (!isNaN(n) && n > 0) return n;
    }
    return NaN;
  }
  function updateScopeBars(scope) {
    var bars = (scope || document).querySelectorAll(".scope-bar[data-key]");
    for (var b = 0; b < bars.length; b++) {
      var bar = bars[b];
      var file = RD.files[bar.dataset.key];
      var pre = bar.parentElement && bar.parentElement.querySelector("pre.source");
      var sym = bar.querySelector(".scope-sym");
      if (!file || !pre || !sym) continue;
      var line = firstVisibleLine(bar, pre);
      sym.textContent = isNaN(line) ? "" : scopeLabel(file, line);
    }
  }
  window.updateScopeBars = updateScopeBars;
  /* Anywhere on a scope bar folds its pane, GitHub-style; the bar's own
     controls, if any, keep their meaning. */
  document.addEventListener("click", function (e) {
    var bar = e.target instanceof Element ? e.target.closest(".scope-bar") : null;
    if (!bar || e.target.closest("a, button")) return;
    var pane = bar.closest(".code-pane");
    var pre = pane && pane.querySelector(":scope > pre.source");
    if (!pane || !pre) return;
    var folded = !pane.classList.contains("collapsed");
    /* The cap is measured, never auto: a transition needs two lengths, and
       the same two in both directions. Closing, the height the source has
       now. Opening, the height it will have — found by unfolding it for one
       silent layout, with transitions off, and folding it back before the
       real change is made. */
    var height;
    if (folded) {
      height = pre.offsetHeight;
    } else {
      pre.style.transition = "none";
      pane.classList.remove("collapsed");
      height = pre.offsetHeight;
      pane.classList.add("collapsed");
      void pre.offsetHeight;
      pre.style.transition = "";
    }
    pane.style.setProperty("--pane-h", height + "px");
    void pre.offsetHeight;
    pane.classList.toggle("collapsed", folded);
    bar.setAttribute("aria-expanded", folded ? "false" : "true");
  });
  /* Open again, the cap comes off, so a pane that later grows — a gap
     expanded — is not clipped at the height it happened to have. */
  document.addEventListener("transitionend", function (e) {
    if (e.propertyName !== "max-height" || !(e.target instanceof Element)) return;
    var pane = e.target.closest(".code-pane");
    if (pane && !pane.classList.contains("collapsed")) pane.style.removeProperty("--pane-h");
  });
  document.addEventListener("scroll", function (e) {
    var pane = e.target instanceof Element ? e.target.closest(".panel, .col") : null;
    if (!pane) return;
    requestAnimationFrame(function () { updateScopeBars(pane); });
  }, true);
`;

/** A symbol for the page: label, bare name, start, end, children — short keys, it is repeated a lot. */
function symbolBlob(s: SymbolRange): unknown {
  return {
    l: symbolLabel(s),
    n: s.name,
    s: s.startLine,
    e: s.endLine,
    ...(s.children?.length ? { c: s.children.map(symbolBlob) } : {}),
  };
}

export function renderDataBlob(index: FileIndex): string {
  const files: Record<string, unknown> = {};
  for (const [key, entry] of index) {
    files[key] = {
      html: entry.html,
      count: entry.lines.length,
      symbols: entry.symbols.map(symbolBlob),
    };
  }
  return JSON.stringify({ step: EXPAND_STEP, files }).replaceAll("</", "<\\/");
}

// ---------------------------------------------------------------------------
// Diff decorations over a file's own lines

/** New-file line numbers added by these hunks. */
export function addedLines(hunks: DiffHunk[]): Set<number> {
  const added = new Set<number>();
  for (const hunk of hunks) {
    let newN = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("-") || line.startsWith("\\")) continue;
      if (line.startsWith("+")) added.add(newN);
      newN++;
    }
  }
  return added;
}

/**
 * Removed line texts keyed by the new-file line they now sit above, so a
 * source block on the new side can interleave them as red deletion rows.
 */
export function deletedLinesByPosition(hunks: DiffHunk[]): Map<number, string[]> {
  const deleted = new Map<number, string[]>();
  for (const hunk of hunks) {
    let newN = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("-")) {
        const texts = deleted.get(newN) ?? [];
        texts.push(line.slice(1));
        deleted.set(newN, texts);
      } else {
        newN++;
      }
    }
  }
  return deleted;
}
