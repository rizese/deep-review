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
