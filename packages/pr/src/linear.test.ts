import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildError, ConfigError, InputError, TransientError } from "./errors.js";
import { extractIssueIdentifiers, fetchLinearIssues } from "./linear.js";

describe("extractIssueIdentifiers", () => {
  it("finds identifiers in Linear URLs", () => {
    expect(
      extractIssueIdentifiers(
        "Fixes https://linear.app/acme/issue/ENG-123/retry-budget",
      ),
    ).toEqual(["ENG-123"]);
  });

  it("finds bare mentions and the branch name", () => {
    expect(
      extractIssueIdentifiers("Part of ENG-7.", "", "adam/ENG-8-cleanup"),
    ).toEqual(["ENG-7", "ENG-8"]);
  });

  it("deduplicates across forms, keeping first appearance order", () => {
    expect(
      extractIssueIdentifiers(
        "See PLAT-42 and https://linear.app/acme/issue/ENG-9/x, also ENG-9 again.",
      ),
    ).toEqual(["ENG-9", "PLAT-42"]);
  });

  it("ignores lookalikes that are not team keys", () => {
    expect(
      extractIssueIdentifiers("Encode as UTF-8 per RFC-7231, fixes CVE-2024."),
    ).toEqual([]);
  });

  it("ignores identifiers embedded in longer tokens", () => {
    expect(extractIssueIdentifiers("the ENG-8x build and X-ENG-2")).toEqual([]);
  });
});

describe("fetchLinearIssues", () => {
  const saved = process.env.LINEAR_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = saved;
  });

  /** The error a lookup rejects with when Linear answers like this. */
  const failure = async (init: ResponseInit, body = "{}"): Promise<unknown> => {
    process.env.LINEAR_API_KEY = "k";
    vi.stubGlobal("fetch", async () => new Response(body, init));
    return fetchLinearIssues(["ENG-1"]).then(
      () => {
        throw new Error("expected the lookup to fail");
      },
      (error: unknown) => error,
    );
  };

  it("says nothing at all without a key, rather than failing", async () => {
    delete process.env.LINEAR_API_KEY;
    await expect(fetchLinearIssues(["ENG-1"])).resolves.toEqual([]);
  });

  it("classifies Linear's failures the way GitHub's are classified", async () => {
    expect(await failure({ status: 401 })).toBeInstanceOf(ConfigError);
    expect(await failure({ status: 429 })).toBeInstanceOf(TransientError);
    expect(await failure({ status: 502 })).toBeInstanceOf(TransientError);
    const bad = await failure({ status: 400 });
    expect(bad).toBeInstanceOf(InputError);
    expect((bad as Error).message).toBe("Linear API returned 400 for ENG-1");
  });

  it("reads a GraphQL error's message, since its status is always 200", async () => {
    const query = await failure({ status: 200 }, JSON.stringify({ errors: [{ message: "nope" }] }));
    expect(query).toBeInstanceOf(BuildError);
    expect((query as Error).message).toBe("Linear API error for ENG-1: nope");
    expect(
      await failure({ status: 200 }, JSON.stringify({ errors: [{ message: "Rate limit hit" }] })),
    ).toBeInstanceOf(TransientError);
    expect(
      await failure({ status: 200 }, JSON.stringify({ errors: [{ message: "Invalid API key" }] })),
    ).toBeInstanceOf(ConfigError);
  });
});
