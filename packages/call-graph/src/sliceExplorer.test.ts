import { describe, expect, it } from "vitest";
import { fileBlockRanges } from "./diffView.js";
import { explorerSize, fragmentSize, type SliceExplorerInput } from "./sliceExplorer.js";

const fragment = {
  id: "a.ts#0@1-3",
  file: "a.ts",
  summary: "calls retry",
  hunkHeader: "@@ -1,2 +1,3 @@",
  lines: [
    " const x = 1;",
    "+retry();",
    "-const retryDelayed = 2;",
    "+function retry() {}",
  ],
  newLineNumbers: [1, 2, null, 3] as (number | null)[],
  headStart: 1,
  headEnd: 3,
};

/** A second fragment in the same file, far enough away to leave a gap. */
const farFragment = {
  id: "a.ts#1@1-1",
  file: "a.ts",
  summary: "later change",
  hunkHeader: "@@ -40,1 +40,1 @@",
  lines: ["+const y = 2;"],
  newLineNumbers: [40] as (number | null)[],
  headStart: 40,
  headEnd: 40,
};

describe("fileBlockRanges", () => {
  it("pads each fragment with context and merges touching pads", () => {
    expect(fileBlockRanges([fragment, farFragment], 60)).toEqual([
      [1, 8],
      [35, 45],
    ]);
    const near = { ...farFragment, headStart: 12, headEnd: 12 };
    expect(fileBlockRanges([fragment, near], 60)).toEqual([[1, 17]]);
  });

  it("gives a deletion-only fragment context around the point it sits at", () => {
    const deletion = { ...farFragment, headStart: 40, headEnd: 39, newLineNumbers: [null] };
    expect(fileBlockRanges([deletion], 60)).toEqual([[35, 44]]);
  });
});

describe("size breakdown", () => {
  const core = { ...fragment, kind: "core" as const };
  const test = { ...farFragment, kind: "test" as const };
  const boilerplate = { ...fragment, id: "a.ts#0@1-3-b", kind: "boilerplate" as const };

  const input = (slices: SliceExplorerInput["slices"]): SliceExplorerInput => ({
    prUrl: "https://github.com/a/b/pull/1",
    prTitle: "A PR",
    repo: "a/b",
    number: 1,
    overview: "does a thing",
    files: [],
    slices,
  });

  it("splits a classified set by kind, counting only added and removed lines", () => {
    expect(fragmentSize([core, test])).toEqual({
      byKind: {
        core: { additions: 2, deletions: 1 },
        test: { additions: 1, deletions: 0 },
        boilerplate: { additions: 0, deletions: 0 },
      },
      total: { additions: 3, deletions: 1 },
    });
  });

  it("sums every slice into the PR's breakdown", () => {
    const size = explorerSize(
      input([
        { id: "slice-1", title: "First", summary: "s", rationale: "r", fragments: [core, test] },
        { id: "slice-2", title: "Second", summary: "s2", rationale: "r2", fragments: [boilerplate] },
      ]),
    );
    expect(size.byKind).toEqual({
      core: { additions: 2, deletions: 1 },
      test: { additions: 1, deletions: 0 },
      boilerplate: { additions: 2, deletions: 1 },
    });
    expect(size.total).toEqual({ additions: 5, deletions: 2 });
  });

  it("counts a set that changed no lines as zero, with its kinds still split", () => {
    expect(explorerSize(input([]))).toEqual({
      byKind: {
        core: { additions: 0, deletions: 0 },
        test: { additions: 0, deletions: 0 },
        boilerplate: { additions: 0, deletions: 0 },
      },
      total: { additions: 0, deletions: 0 },
    });
  });

  it("falls back to one unsplit total when any fragment is unclassified", () => {
    // An older report: its fragments carry no kind, so a partial split would
    // stop adding up to the total.
    const size = explorerSize(
      input([
        { id: "slice-1", title: "First", summary: "s", rationale: "r", fragments: [fragment, farFragment] },
        { id: "slice-2", title: "Second", summary: "s2", rationale: "r2", fragments: [fragment] },
      ]),
    );
    expect(size.byKind).toBeNull();
    expect(size.total).toEqual({ additions: 5, deletions: 2 });
  });
});
