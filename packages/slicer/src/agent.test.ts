import { ConfigError, InputError, parseUnifiedDiff } from "@deep-review/pr";
import { afterEach, describe, expect, it } from "vitest";
import { apiKeyEnvVars, hasApiKeyForModel, runSliceAgent } from "./agent.js";
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

describe("which provider a model id names", () => {
  /**
   * The id alone decides where the call goes, so this is the whole of the
   * routing rule and the only thing standing between a typo and a request
   * to the wrong provider.
   */
  it("sends gpt- to OpenAI, grok- to xAI, and everything else to Anthropic", () => {
    expect(apiKeyEnvVars("gpt-5.6-sol")).toEqual(["OPENAI_API_KEY"]);
    expect(apiKeyEnvVars("grok-4")).toEqual(["XAI_API_KEY", "GROK_API_KEY"]);
    expect(apiKeyEnvVars("claude-sonnet-4.5")).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("wants the key of the provider the id names, and no other", () => {
    const saved = { ...process.env };
    try {
      for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GROK_API_KEY"]) delete process.env[name];
      expect(hasApiKeyForModel("gpt-5.6-sol")).toBe(false);
      // An Anthropic key is no use to an OpenAI model.
      process.env.ANTHROPIC_API_KEY = "sk-ant";
      expect(hasApiKeyForModel("gpt-5.6-sol")).toBe(false);
      expect(hasApiKeyForModel("claude-sonnet-4.5")).toBe(true);
      // Either of xAI's two names will do.
      process.env.GROK_API_KEY = "sk-xai";
      expect(hasApiKeyForModel("grok-4")).toBe(true);
    } finally {
      process.env = saved;
    }
  });
});
