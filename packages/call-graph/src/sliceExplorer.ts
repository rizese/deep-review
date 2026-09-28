/**
 * What a built PR is, as the client app and the navigation server both read
 * it: the slices, their fragments, the files they touch, and the sizes
 * derived from them. The page itself is the client app's (packages/ui);
 * what stays here is the shape of the input and the panel renderer the
 * navigation server answers `/panel` with.
 */

import type { PanelRenderer } from "./navSession.js";
import { renderDefinitionPanel } from "./explorer.js";
import { buildFileIndex, type FileIndex } from "./html.js";

import type { CallPathResult, EmbeddedFile, FileDiff } from "./types.js";

/** Mirrors the slicer's `FragmentKind`; see the note on SliceFragmentInput. */
export type FragmentKind = "core" | "test" | "boilerplate";

/**
 * One fragment of a slice: a contiguous run of diff lines. Given
 * structurally rather than imported from the slicer package, so the two
 * analysis packages stay independent of each other.
 */
export interface SliceFragmentInput {
  id: string;
  file: string;
  summary: string;
  /**
   * How the slicer classed this run of lines, so a slice's size can be read
   * as core / tests / boilerplate rather than one number. Absent on reports
   * written before fragments were classified.
   */
  kind?: FragmentKind | undefined;
  /** The `@@ ... @@` header of the hunk this fragment sits in. */
  hunkHeader: string;
  /** Raw diff lines, each still prefixed with " ", "+", "-", or "\\". */
  lines: string[];
  /** Head-side file line per entry of `lines`; null for removed lines. */
  newLineNumbers: (number | null)[];
  /**
   * The fragment's extent in the head-side file, used to place it among its
   * file's other fragments and to work out how much context surrounds it.
   * A fragment that only removes lines has no extent, and is marked by
   * `headEnd === headStart - 1` — it sits between two lines rather than on
   * any of them.
   */
  headStart: number;
  headEnd: number;
}

export interface SliceInput {
  id: string;
  title: string;
  summary: string;
  rationale: string;
  target?: { file: string; name: string } | undefined;
  fragments: SliceFragmentInput[];
  /**
   * The walked call graph rooted at this slice's target, when one was named
   * and the analysis succeeded. Without it the slice has no horizontal
   * dimension — its diff is all there is to see.
   */
  graph?: CallPathResult | undefined;
}

export interface SliceExplorerInput {
  prUrl: string;
  prTitle: string;
  repo: string;
  number: number;
  overview: string;
  /**
   * The PR description as authored, Markdown and all. Reached from the
   * sidebar: what the author says the change is for, next to what it
   * actually does. Absent or empty still gets the entry, with a note that
   * the PR has no description — its absence is itself worth seeing.
   */
  prDescription?: string | undefined;
  /** The PR's author, shown alongside the description. */
  prAuthor?: string | undefined;
  slices: SliceInput[];
  /**
   * Head-side text of every file the slices touch. This is what lets a
   * file's fragments be shown as one continuous stretch of the file, with
   * real context between them and expanders over what stays hidden. A file
   * missing here (one the PR deleted, say) falls back to fragment-by-
   * fragment rendering.
   */
  files: EmbeddedFile[];
  /**
   * The path prefix the navigation server mounts this PR under, with a
   * trailing slash (`/pr/vercel/swr/2950/`). Every question the page asks
   * about a symbol is resolved against it, which is what lets one server
   * answer for several PRs. Absent in a static copy — nothing to ask.
   */
  navBase?: string | undefined;
  /**
   * The PR's diff, whole. Slices partition the diff between them, but a
   * panel opened by a symbol click is about a declaration, not a slice —
   * a function added by slice 1 has to read as added when it is reached
   * from slice 2, so panels are shaded from the PR's changes rather than
   * from the fragments of whichever slice the reader walked in from.
   * Absent, opened panels show plain source.
   */
  diff?: FileDiff[] | undefined;
  /**
   * Debug builds: every marked symbol says why it is marked, and every
   * identifier what the navigation server said about it, in a hint shown
   * while Shift is held.
   */
  debugMarks?: boolean | undefined;
}

/**
 * The panel renderer for this page's navigation session: definitions the
 * reader reaches by clicking are rendered against the page's own file
 * index, built once, on the first panel — most sessions never open one.
 */
export function panelRendererFor(input: SliceExplorerInput): PanelRenderer {
  let index: FileIndex | null = null;
  const debug = input.debugMarks ?? false;
  return (def, hunks) => {
    index ??= explorerFileIndex(input);
    return renderDefinitionPanel(def, index, { debug, hunks });
  };
}

/**
 * One file index for the whole PR: files shared between slices key
 * identically, and the changed files come first so that a file a call graph
 * also embedded wins — those entries carry the symbol table breadcrumbs are
 * read from.
 */
export function explorerFileIndex(input: SliceExplorerInput): FileIndex {
  return buildFileIndex([...input.files, ...input.slices.flatMap((s) => s.graph?.files ?? [])], {
    debug: input.debugMarks,
  });
}

interface LineDelta {
  additions: number;
  deletions: number;
}

/**
 * A set of fragments' size: the total, and the same lines split by kind when
 * every fragment was classified. `byKind` is null otherwise — a partial split
 * would quietly stop adding up to the total.
 */
export interface SizeBreakdown {
  byKind: Record<FragmentKind, LineDelta> | null;
  total: LineDelta;
}

export function fragmentSize(fragments: readonly SliceFragmentInput[]): SizeBreakdown {
  const total: LineDelta = { additions: 0, deletions: 0 };
  const byKind: Record<FragmentKind, LineDelta> = {
    core: { additions: 0, deletions: 0 },
    test: { additions: 0, deletions: 0 },
    boilerplate: { additions: 0, deletions: 0 },
  };
  let classified = true;
  for (const fragment of fragments) {
    const into = fragment.kind ? byKind[fragment.kind] : null;
    if (!into) classified = false;
    for (const line of fragment.lines) {
      if (line.startsWith("+")) {
        total.additions++;
        if (into) into.additions++;
      } else if (line.startsWith("-")) {
        total.deletions++;
        if (into) into.deletions++;
      }
    }
  }
  return { byKind: classified ? byKind : null, total };
}

/** The whole PR's size: every slice's fragments together. */
export function explorerSize(input: SliceExplorerInput): SizeBreakdown {
  return fragmentSize(input.slices.flatMap((s) => s.fragments));
}
