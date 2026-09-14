import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileStore, isStoredPr, memoryStore, type StoredPr } from "./store.js";

function ready(number: number, extra: Partial<StoredPr> = {}): StoredPr {
  return {
    version: 1,
    state: "ready",
    owner: "acme",
    repo: "widgets",
    number,
    options: {},
    facts: { role: "review" },
    addedAt: 1,
    readyAt: 2,
    built: {
      headDir: "/tmp/head",
      input: { prUrl: "u", prTitle: `PR ${number}`, repo: "acme/widgets", number, overview: "", files: [], slices: [] },
    },
    ...extra,
  };
}

describe("fileStore", () => {
  let home: string;
  let dir: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "store-test-"));
    dir = path.join(home, "prs");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("keeps one file per PR, named so a strange owner or repo cannot escape the directory", () => {
    const store = fileStore(dir);
    store.save(ready(1));
    store.save(ready(2, { owner: "we/ird", repo: "na me" }));
    expect(readdirSync(dir).sort()).toEqual(["acme__widgets__1.json", "we%2Fird__na%20me__2.json"]);
    // No temp file is left behind: the write went to a temp name and was renamed.
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(store.load().map((p) => p.number).sort()).toEqual([1, 2]);
    store.remove({ owner: "acme", repo: "widgets", number: 1 });
    expect(store.load().map((p) => p.number)).toEqual([2]);
    // Removing what is not there is not an error.
    store.remove({ owner: "acme", repo: "widgets", number: 9 });
  });

  it("stores failed PRs too, with their reason", () => {
    const store = fileStore(dir);
    store.save({ ...ready(3), state: "failed", built: undefined, readyAt: undefined, error: "no key", failedAt: 5 });
    expect(store.load()).toEqual([expect.objectContaining({ state: "failed", error: "no key", failedAt: 5 })]);
  });

  it("skips files it cannot trust, saying so, rather than failing the whole load", () => {
    const problems: string[] = [];
    const store = fileStore(dir, { onProblem: (m) => problems.push(m) });
    store.save(ready(1));
    writeFileSync(path.join(dir, "acme__widgets__2.json"), "{ not json");
    writeFileSync(path.join(dir, "acme__widgets__3.json"), JSON.stringify({ owner: "acme" }));
    writeFileSync(path.join(dir, "README.txt"), "ignored");
    expect(store.load().map((p) => p.number)).toEqual([1]);
    expect(problems).toHaveLength(2);
  });

  it("converts the old single registry.json once, dropping its HTML, and moves it aside", () => {
    const legacy = path.join(home, "registry.json");
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        prs: [
          {
            owner: "acme",
            repo: "widgets",
            number: 7,
            options: { maxGraphs: 2 },
            facts: { role: "authored", approved: true },
            addedAt: 10,
            readyAt: 20,
            built: { input: ready(7).built!.input, headDir: "/tmp/h", html: "<html>huge</html>", headSha: "abc" },
          },
          { owner: "acme", number: 8 },
        ],
      }),
    );
    const problems: string[] = [];
    const store = fileStore(dir, { legacyFile: legacy, onProblem: (m) => problems.push(m) });
    const loaded = store.load();
    expect(loaded).toEqual([
      expect.objectContaining({
        state: "ready",
        number: 7,
        options: { maxGraphs: 2 },
        facts: { role: "authored", approved: true },
        readyAt: 20,
        built: expect.objectContaining({ headDir: "/tmp/h", headSha: "abc" }),
      }),
    ]);
    expect(JSON.stringify(loaded)).not.toContain("huge");
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.migrated`)).toBe(true);
    expect(problems).toEqual([expect.stringMatching(/converted 1 PR from registry\.json/)]);
    // A second load finds nothing left to convert and the same record.
    expect(store.load()).toHaveLength(1);
    expect(readFileSync(path.join(dir, "acme__widgets__7.json"), "utf8")).toContain('"number":7');
  });
});

describe("isStoredPr", () => {
  it("requires a build for a ready record and a reason for a failed one", () => {
    expect(isStoredPr(ready(1))).toBe(true);
    expect(isStoredPr({ ...ready(1), built: undefined })).toBe(false);
    expect(isStoredPr({ ...ready(1), state: "failed", error: "x" })).toBe(true);
    expect(isStoredPr({ ...ready(1), state: "failed", error: undefined })).toBe(false);
    expect(isStoredPr({ ...ready(1), state: "building" })).toBe(false);
    expect(isStoredPr(null)).toBe(false);
  });
});

describe("memoryStore", () => {
  it("behaves like the file store without touching disk", () => {
    const store = memoryStore();
    store.save(ready(1));
    store.save(ready(1, { readyAt: 9 }));
    expect(store.load()).toEqual([expect.objectContaining({ readyAt: 9 })]);
    store.remove(ready(1));
    expect(store.load()).toEqual([]);
  });
});
