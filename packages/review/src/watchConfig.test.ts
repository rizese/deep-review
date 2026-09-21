import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_AUTHORED_SEARCHES, DEFAULT_REVIEW_SEARCHES } from "@deep-review/pr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWatchedRepo,
  parseWatchConfig,
  readWatchConfig,
  searchesForRepo,
  watchConfigFile,
  writeWatchConfig,
} from "./watchConfig.js";

describe("parseWatchConfig", () => {
  it("reads the searches behind each tab, in order", () => {
    const parsed = parseWatchConfig({
      searches: { review: ["is:open is:pr assignee:@me"], authored: ["is:open is:pr author:@me"] },
    });
    expect(parsed.review).toEqual(["is:open is:pr assignee:@me"]);
    expect(parsed.authored).toEqual(["is:open is:pr author:@me"]);
    expect(parsed.searches).toEqual([
      { role: "review", query: "is:open is:pr assignee:@me" },
      { role: "authored", query: "is:open is:pr author:@me" },
    ]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.fromDefaults).toBe(false);
  });

  it("takes several searches for one tab, since GitHub cannot OR two qualifiers", () => {
    const parsed = parseWatchConfig({
      searches: { review: ["is:open assignee:@me", "is:open review-requested:@me"], authored: [] },
    });
    expect(parsed.searches.map((s) => s.role)).toEqual(["review", "review"]);
    expect(parsed.authored).toEqual([]);
  });

  it("trims each search and keeps one written as a bare string", () => {
    const parsed = parseWatchConfig({ searches: { review: "  is:open assignee:@me  " } });
    expect(parsed.review).toEqual(["is:open assignee:@me"]);
    // A tab the file says nothing about keeps its default.
    expect(parsed.authored).toEqual(DEFAULT_AUTHORED_SEARCHES);
  });

  it("falls back to the searches that name you when the document says nothing", () => {
    // `{}` and no document at all both mean the defaults, which are bound
    // by `@me`; they can never mean every PR the token can see.
    for (const doc of [{}, null, { searches: { review: [], authored: [] } }]) {
      const parsed = parseWatchConfig(doc);
      expect(parsed.review).toEqual(DEFAULT_REVIEW_SEARCHES);
      expect(parsed.authored).toEqual(DEFAULT_AUTHORED_SEARCHES);
      expect(parsed.fromDefaults).toBe(true);
    }
  });

  it("skips a search bound to nobody and nowhere, naming the problem", () => {
    const parsed = parseWatchConfig({
      searches: { review: ["is:open is:pr", "is:open is:pr repo:acme/widgets"], authored: [] },
    });
    expect(parsed.review).toEqual(["is:open is:pr repo:acme/widgets"]);
    expect(parsed.problems).toEqual([expect.stringMatching(/names nobody and nowhere/)]);
  });

  it("skips what is not a string, and reports a searches field of the wrong shape", () => {
    const parsed = parseWatchConfig({ searches: { review: [7, "", "is:open assignee:@me"], authored: [] } });
    expect(parsed.review).toEqual(["is:open assignee:@me"]);
    expect(parsed.problems).toHaveLength(2);
    expect(parseWatchConfig({ searches: ["is:open"] }).problems).toHaveLength(1);
    expect(parseWatchConfig({ searches: ["is:open"] }).fromDefaults).toBe(true);
  });

  it("reads an old repo-list file as the searches those repos stood for", () => {
    // An upgrade must watch what it watched yesterday, not everything.
    const parsed = parseWatchConfig({ repos: { "acme/widgets": {} } });
    expect(parsed.migrated).toBe(true);
    expect(parsed.review).toEqual(DEFAULT_REVIEW_SEARCHES.map((q) => `${q} repo:acme/widgets`));
    expect(parsed.authored).toEqual(DEFAULT_AUTHORED_SEARCHES.map((q) => `${q} repo:acme/widgets`));
  });

  it("keeps an old entry's own queries when reading it, scoped to its repo", () => {
    const parsed = parseWatchConfig({
      repos: { "acme/widgets": { query: "is:open label:x", authoredQuery: "is:open author:@me -is:draft" } },
    });
    expect(parsed.review).toEqual(["is:open label:x repo:acme/widgets"]);
    expect(parsed.authored).toEqual(["is:open author:@me -is:draft repo:acme/widgets"]);
  });

  it("skips an old entry whose key is not an owner/repo", () => {
    const parsed = parseWatchConfig({ repos: { "not-a-repo": {}, "acme/widgets": {} } });
    expect(parsed.review.every((q) => q.endsWith("repo:acme/widgets"))).toBe(true);
    expect(parsed.problems).toEqual([expect.stringMatching(/not an owner\/repo/)]);
  });

  it("prefers searches over a repo list when a file carries both", () => {
    const parsed = parseWatchConfig({
      searches: { review: ["is:open assignee:@me"], authored: [] },
      repos: { "acme/widgets": {} },
    });
    expect(parsed.review).toEqual(["is:open assignee:@me"]);
    expect(parsed.migrated).toBe(false);
  });
});

describe("searchesForRepo", () => {
  it("narrows both tabs' defaults to one repo", () => {
    expect(searchesForRepo("acme/widgets")).toEqual({
      review: DEFAULT_REVIEW_SEARCHES.map((q) => `${q} repo:acme/widgets`),
      authored: DEFAULT_AUTHORED_SEARCHES.map((q) => `${q} repo:acme/widgets`),
    });
  });
});

describe("readWatchConfig / writeWatchConfig / addWatchedRepo", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "watch-config-test-"));
    process.env.DEEP_REVIEW_HOME = home;
  });

  afterEach(() => {
    delete process.env.DEEP_REVIEW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("lives under the state dir, beside the watcher's own state", () => {
    expect(watchConfigFile()).toBe(path.join(home, "watch.json"));
  });

  it("reads the defaults, with no problems, when there is no file", () => {
    const parsed = readWatchConfig();
    expect(parsed.review).toEqual(DEFAULT_REVIEW_SEARCHES);
    expect(parsed.fromDefaults).toBe(true);
    expect(parsed.problems).toEqual([]);
  });

  it("reads the defaults and one problem when the file is not JSON", () => {
    writeFileSync(watchConfigFile(), "nope");
    const parsed = readWatchConfig();
    expect(parsed.review).toEqual(DEFAULT_REVIEW_SEARCHES);
    expect(parsed.problems).toEqual([expect.stringContaining("could not be read")]);
  });

  it("writes both tabs' searches as a readable document, and reads them back", () => {
    writeWatchConfig({ review: ["is:open is:pr user:spara-ai assignee:@me"], authored: ["is:open is:pr author:@me"] });
    expect(JSON.parse(readFileSync(watchConfigFile(), "utf8"))).toEqual({
      searches: { review: ["is:open is:pr user:spara-ai assignee:@me"], authored: ["is:open is:pr author:@me"] },
    });
    expect(readWatchConfig().review).toEqual(["is:open is:pr user:spara-ai assignee:@me"]);
  });

  it("narrows the defaults to one repo rather than adding to them", () => {
    // The defaults are unscoped; keeping them beside a repo-scoped search
    // would still bring in everything, which is not what --repo asks for.
    const { added } = addWatchedRepo("acme/widgets");
    expect(added).toBe(true);
    expect(readWatchConfig().review).toEqual(DEFAULT_REVIEW_SEARCHES.map((q) => `${q} repo:acme/widgets`));
  });

  it("adds a repo beside the ones already narrowed to", () => {
    addWatchedRepo("acme/gadgets");
    addWatchedRepo("acme/widgets");
    const review = readWatchConfig().review;
    expect(review.some((q) => q.endsWith("repo:acme/gadgets"))).toBe(true);
    expect(review.some((q) => q.endsWith("repo:acme/widgets"))).toBe(true);
  });

  it("leaves a repo already searched for alone", () => {
    addWatchedRepo("acme/widgets");
    const before = readFileSync(watchConfigFile(), "utf8");
    expect(addWatchedRepo("acme/widgets").added).toBe(false);
    expect(readFileSync(watchConfigFile(), "utf8")).toBe(before);
  });

  it("reads an old repo-list file, so --repo on one keeps the other", () => {
    writeFileSync(watchConfigFile(), JSON.stringify({ repos: { "acme/gadgets": {} } }));
    addWatchedRepo("acme/widgets");
    const review = readWatchConfig().review;
    expect(review.some((q) => q.endsWith("repo:acme/gadgets"))).toBe(true);
    expect(review.some((q) => q.endsWith("repo:acme/widgets"))).toBe(true);
  });
});
