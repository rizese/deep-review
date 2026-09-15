import type { FragmentKind, SizeBreakdown, SliceExplorerInput, SliceFragmentInput } from "./callGraph.js";

/**
 * A set of fragments' size, counted the way `fragmentSize` in
 * `sliceExplorer.ts` counts it. Repeated here rather than imported because
 * that module reaches the language services through `explorer.ts`, and
 * nothing that reaches them can be bundled for the browser.
 */
export function fragmentSize(fragments: readonly SliceFragmentInput[]): SizeBreakdown {
  const total = { additions: 0, deletions: 0 };
  const byKind: Record<FragmentKind, { additions: number; deletions: number }> = {
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
