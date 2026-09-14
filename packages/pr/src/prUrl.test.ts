import { describe, expect, it } from "vitest";
import { ConfigError, InputError } from "./errors.js";
import { parsePrTarget, parsePrUrl, prUrl } from "./prUrl.js";

describe("parsePrUrl", () => {
  it("parses a plain PR URL", () => {
    expect(parsePrUrl("https://github.com/vercel/swr/pull/2950")).toEqual({
      owner: "vercel",
      repo: "swr",
      number: 2950,
    });
  });

  it("tolerates trailing paths like /files", () => {
    expect(parsePrUrl("https://github.com/a/b/pull/7/files#diff-x").number).toBe(7);
  });

  it("rejects non-PR URLs", () => {
    expect(() => parsePrUrl("https://github.com/a/b/issues/7")).toThrow(
      /Not a GitHub PR URL/,
    );
    expect(() => parsePrUrl("https://gitlab.com/a/b/pull/7")).toThrow();
    // The target itself is what is wrong here: nothing about this machine
    // would make that URL parse.
    expect(() => parsePrUrl("https://github.com/a/b/issues/7")).toThrow(InputError);
  });
});

describe("parsePrTarget", () => {
  it("takes a bare number against a default repo", () => {
    expect(parsePrTarget("10511", "spara-ai/spara-app")).toEqual({
      owner: "spara-ai",
      repo: "spara-app",
      number: 10511,
    });
    expect(parsePrTarget("#7", "a/b").number).toBe(7);
  });

  it("still takes a full URL, ignoring the default repo", () => {
    expect(parsePrTarget("https://github.com/vercel/swr/pull/2950", "a/b")).toEqual({
      owner: "vercel",
      repo: "swr",
      number: 2950,
    });
  });

  it("rejects a bare number with no repo", () => {
    expect(() => parsePrTarget("10511")).toThrow(/needs a repo/);
    // Setup, not input: the number is fine, the repo it needs was never set.
    expect(() => parsePrTarget("10511")).toThrow(ConfigError);
  });

  it("rejects a malformed default repo", () => {
    expect(() => parsePrTarget("10511", "spara-app")).toThrow(/owner>\/<repo/);
    expect(() => parsePrTarget("10511", "spara-app")).toThrow(ConfigError);
  });
});

describe("prUrl", () => {
  it("round-trips a ref", () => {
    const url = "https://github.com/vercel/swr/pull/2950";
    expect(prUrl(parsePrUrl(url))).toBe(url);
  });
});
