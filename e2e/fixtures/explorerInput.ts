/**
 * A deterministic PR for the visual baselines: two files, two slices, one
 * walkable call graph with a call site, a Markdown description. Small
 * enough to read in a screenshot, rich enough to exercise every part of the
 * explorer's chrome — sidebar, size bars, scope bars, panels, description.
 */
import type { CallPathResult, EmbeddedFile, SliceExplorerInput } from "../../packages/call-graph/src/index.js";

export const libText = [
  "export const LIMIT = 3;",
  "",
  "/** Adds the configured limit to a count. */",
  "export function helper(n: number): number {",
  "  return n + LIMIT;",
  "}",
  "",
  "export function unrelated(): void {}",
];

export const useText = [
  'import { helper, LIMIT } from "./lib.js";',
  "",
  "export function use(x: number): number {",
  "  const total = helper(x) + LIMIT;",
  "  return total + Math.max(total, 0);",
  "}",
  "",
  "export function later(xs: number[]): number[] {",
  "  return xs.map(helper);",
  "}",
];

export const testText = [
  'import { describe, expect, it } from "vitest";',
  'import { use } from "../use.js";',
  "",
  'describe("use", () => {',
  '  it("adds the limit twice", () => {',
  "    expect(use(1)).toBe(8);",
  "  });",
  "});",
];

const files: EmbeddedFile[] = [
  {
    side: "after",
    path: "use.ts",
    lines: useText,
    symbols: [
      { name: "use", kind: "function", startLine: 3, endLine: 6 },
      { name: "later", kind: "function", startLine: 8, endLine: 10 },
    ],
  },
  {
    side: "after",
    path: "lib.ts",
    lines: libText,
    symbols: [
      { name: "helper", kind: "function", startLine: 4, endLine: 6 },
      { name: "unrelated", kind: "function", startLine: 8, endLine: 8 },
    ],
  },
  { side: "after", path: "test/use.test.ts", lines: testText, symbols: [] },
];

const graph: CallPathResult = {
  prUrl: "https://github.com/acme/widgets/pull/1",
  prTitle: "Add the limit twice",
  functionName: "use",
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "pull/1/head", sha: "b".repeat(40) },
  rootId: "use.ts#use",
  nodes: [
    {
      id: "use.ts#use",
      name: "use",
      file: "use.ts",
      presence: "both",
      before: { file: "use.ts", startLine: 3, endLine: 5, callSites: [], source: [{ startLine: 3, lines: useText.slice(2, 5) }], truncated: false },
      after: {
        file: "use.ts",
        startLine: 3,
        endLine: 6,
        callSites: [{ line: 4, snippet: "helper(x)", startColumn: 16, endColumn: 25 }],
        source: [{ startLine: 3, lines: useText.slice(2, 6) }],
        truncated: false,
      },
      hunks: [],
      changedInPr: true,
      expanded: true,
      nameLine: 3,
      nameColumn: 16,
    },
    {
      id: "lib.ts#helper",
      name: "helper",
      file: "lib.ts",
      presence: "both",
      before: null,
      after: { file: "lib.ts", startLine: 4, endLine: 6, callSites: [], source: [{ startLine: 4, lines: libText.slice(3, 6) }], truncated: false },
      hunks: [],
      changedInPr: false,
      expanded: false,
      nameLine: 4,
      nameColumn: 16,
    },
  ],
  edges: [{ from: "use.ts#use", to: "lib.ts#helper", before: [], after: [{ line: 4, snippet: "helper(x)", startColumn: 16, endColumn: 25 }] }],
  files: [{ side: "after", path: "lib.ts", lines: libText, symbols: [] }],
};

export function fixtureInput(number: number, navBase: string): SliceExplorerInput {
  return {
    prUrl: `https://github.com/acme/widgets/pull/${number}`,
    prTitle: number === 1 ? "Add the limit twice" : "Widen the helper",
    repo: "acme/widgets",
    number,
    overview: "Applies the configured limit once more on the way out, and covers it with a test.",
    prDescription: "## Why\n\nThe limit was applied once. It should be applied **twice**, per the spec.\n\n- adds a test\n- no behaviour change for zero",
    prAuthor: "sam",
    navBase,
    files,
    slices: [
      {
        id: "s1",
        title: "Apply the limit on the way out",
        summary: "`use` now adds `LIMIT` to the helper's result before returning.",
        rationale: "The central change; everything else supports it.",
        target: { file: "use.ts", name: "use" },
        fragments: [
          {
            id: "use.ts#0@4-5",
            file: "use.ts",
            summary: "Adds LIMIT to the total and clamps.",
            kind: "core",
            hunkHeader: "@@ -4,1 +4,2 @@",
            lines: ["-  return helper(x);", "+  const total = helper(x) + LIMIT;", "+  return total + Math.max(total, 0);"],
            newLineNumbers: [null, 4, 5],
            headStart: 4,
            headEnd: 5,
          },
        ],
        graph,
      },
      {
        id: "s2",
        title: "Cover the new total",
        summary: "A test pins the doubled limit.",
        rationale: "Mechanical fallout of the core change.",
        fragments: [
          {
            id: "test/use.test.ts#0@4-7",
            file: "test/use.test.ts",
            summary: "Asserts use(1) is 8.",
            kind: "test",
            hunkHeader: "@@ -0,0 +4,4 @@",
            lines: ['+describe("use", () => {', '+  it("adds the limit twice", () => {', "+    expect(use(1)).toBe(8);", "+  });"],
            newLineNumbers: [4, 5, 6, 7],
            headStart: 4,
            headEnd: 7,
          },
        ],
      },
    ],
  };
}
