import { ConfigError, InputError, parseUnifiedDiff } from "@deep-review/pr";
import { afterEach, describe, expect, it } from "vitest";
import { runSliceAgent } from "./agent.js";
import { indexDiff } from "./annotate.js";
import type { PrContext } from "./types.js";

const DIFF = `diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

const index = indexDiff(parseUnifiedDiff(DIFF));

const context = (body: string): PrContext => ({
  info: {
    owner: "acme",
    repo: "widgets",
    number: 1,
    title: "t",
    body,
    author: "a",
    baseRef: "main",
    baseSha: "b",
    headRef: "f",
    headSha: "h",
    cloneUrl: "c",
    htmlUrl: "https://github.com/acme/widgets/pull/1",
    state: "open",
    merged: false,
  },
  tickets: [],
  baseDir: "/tmp/base",
  headDir: "/tmp/head",
  mergeBaseSha: "m",
  diffText: DIFF,
});

describe("runSliceAgent", () => {
  const saved = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it("names the variable to set when the model has no key, before calling anything", async () => {
    // The provider's own missing-key error carries no status and no retry
    // verdict, so it would be read as a pipeline failure and retried against
    // the same empty environment. Asking first makes it setup, and says what.
    delete process.env.ANTHROPIC_API_KEY;
    const failure = await runSliceAgent(context("b"), index, {
      model: "claude-sonnet-4-5",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as Error).message).toContain("ANTHROPIC_API_KEY");
  });

  it("refuses a diff too large to fit in one prompt, as the input it is", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const failure = await runSliceAgent(context("x".repeat(2_100_000)), index, {
      model: "claude-sonnet-4-5",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InputError);
    expect((failure as Error).message).toContain("too large to slice in one pass");
  });
});
