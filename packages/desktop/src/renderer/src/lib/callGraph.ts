/**
 * The one seam between the client app and the analysis package: the pure
 * view-model modules of `packages/call-graph` — tokenizing, diff rows,
 * Markdown — reached by path rather than through the package index, which
 * also exports the analyzer and drags `node:child_process` in with it.
 *
 * Everything here must stay browser-safe. `analyze`, `callHierarchy`,
 * `navSession`, `explorer` and `sliceExplorer` are not (they reach the
 * language services); their *types* are, and are re-exported as types only.
 */

export { escapeHtml, identifierMarks, identifiersOf, languageOf, renderLine, tokenizeLines } from "../../../../../call-graph/src/highlight.js";
export type { Language, Mark } from "../../../../../call-graph/src/highlight.js";

export { buildFileIndex, fileLineHtml, scopeChainFor, scopeLabelFor } from "../../../../../call-graph/src/html.js";
export type { Decorations, FileEntry, FileIndex } from "../../../../../call-graph/src/html.js";

export {
  fileDiffRows,
  firstHeadLine,
  fragmentDiffRows,
  markIntraLine,
  rowsWidth,
  segmentRows,
} from "../../../../../call-graph/src/diffView.js";
export type { DiffRow, LineSpan } from "../../../../../call-graph/src/diffView.js";

export { renderMarkdown } from "../../../../../call-graph/src/markdown.js";

export type {
  CallPathResult,
  CallSite,
  DiffHunk,
  PathNode,
  ReferenceList,
  SourceSegment,
  SymbolRange,
} from "../../../../../call-graph/src/types.js";

export type {
  FragmentKind,
  SizeBreakdown,
  SliceExplorerInput,
  SliceFragmentInput,
  SliceInput,
} from "../../../../../call-graph/src/sliceExplorer.js";

export type { DefinitionAnswer, DefinitionResult } from "../../../../../call-graph/src/navSession.js";
