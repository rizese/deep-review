import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SliceExplorerInput } from "@deep-review/call-graph";
import { BuildError, ConfigError, InputError, TransientError } from "@deep-review/pr";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePrPath, PrRegistry, prKey, prMountPath, type BuiltPr, type PrRef } from "./registry.js";
import { fileStore, memoryStore } from "./store.js";

const headDir = mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
afterAll(() => rmSync(headDir, { recursive: true, force: true }));

function ref(number: number): PrRef {
  return { owner: "a", repo: "b", number };
}

/** The URL the registry derives for `ref(n)` — what the build fn is keyed by. */
function urlOf(number: number): string {
  return `https://github.com/a/b/pull/${number}`;
}

function built(number: number, navBase: string): BuiltPr {
  const input: SliceExplorerInput = {
    prUrl: `https://github.com/a/b/pull/${number}`,
    prTitle: `PR ${number}`,
    repo: "a/b",
    number,
    overview: "o",
    files: [],
    slices: [],
    navBase,
  };
  return { input, headDir };
}

/** A build the test controls: it finishes when told to, or fails. */
function manualBuild() {
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const build = ({ prUrl, navBase }: { prUrl: string; navBase: string }) =>
    new Promise<BuiltPr>((resolve, reject) => {
      const number = Number(prUrl.split("/").pop());
      pending.set(prUrl, {
        resolve: () => resolve(built(number, navBase)),
        reject,
      });
    });
  return { build, pending };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("PrRegistry", () => {
  it("names a PR's key and mount stably, and parses its own mount back", () => {
    expect(prKey(ref(7))).toBe("a/b#7");
    expect(prMountPath(ref(7))).toBe("/pr/a/b/7/");
    // The codec pair roundtrips, so the builder and parser cannot drift.
    const spiky: PrRef = { owner: "we ird", repo: "re/po", number: 12 };
    const route = parsePrPath(prMountPath(spiky));
    expect(route?.ref).toEqual(spiky);
    expect(route?.rest).toBe("/");
    expect(parsePrPath(`${prMountPath(spiky)}panel`)?.rest).toBe("/panel");
    expect(parsePrPath("/pr/%zz/b/1/")).toBeNull();
    expect(parsePrPath("/elsewhere")).toBeNull();
  });

  it("builds what it is given, at most `concurrency` at a time, in order", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build, concurrency: 2 });
    registry.add(ref(1));
    registry.add(ref(2));
    registry.add(ref(3));
    await tick();
    // Two slots: 1 and 2 build, 3 waits.
    expect(registry.list().map((p) => p.state)).toEqual(["building", "building", "queued"]);
    pending.get(urlOf(1))!.resolve();
    await tick();
    expect(registry.get("a/b#1")?.state).toBe("ready");
    expect(registry.get("a/b#3")?.state).toBe("building");
    // The build was told where its page will live.
    expect(registry.get("a/b#1")?.path).toBe("/pr/a/b/1/");
    pending.get(urlOf(2))!.resolve();
    pending.get(urlOf(3))!.resolve();
    await registry.settled();
    registry.dispose();
  });

  it("adds idempotently, but retries a failure", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build });
    registry.add(ref(1));
    registry.add(ref(1));
    await tick();
    expect(registry.list()).toHaveLength(1);
    pending.get(urlOf(1))!.reject(new Error("no key"));
    await registry.settled();
    expect(registry.get("a/b#1")).toMatchObject({ state: "failed", error: "no key" });

    pending.delete(urlOf(1));
    registry.add(ref(1));
    await tick();
    expect(registry.get("a/b#1")?.state).toBe("building");
    pending.get(urlOf(1))!.resolve();
    await registry.settled();
    expect(registry.get("a/b#1")?.state).toBe("ready");
    registry.dispose();
  });

  it("keeps a build log per PR and reports it in the view", async () => {
    const registry = new PrRegistry({
      build: (_request, log) => {
        log("first");
        log("second");
        return Promise.resolve(built(1, "/pr/a/b/1/"));
      },
    });
    registry.add(ref(1));
    await registry.settled();
    const view = registry.get("a/b#1")!;
    expect(view.log.slice(0, 2)).toEqual(["first", "second"]);
    expect(view.log[view.log.length - 1]).toContain("ready");
    registry.dispose();
  });

  it("sizes a built PR from its fragments, split by kind", async () => {
    const registry = new PrRegistry({
      build: () => {
        const b = built(1, "/pr/a/b/1/");
        const fragment = {
          id: "f",
          file: "a.ts",
          summary: "s",
          hunkHeader: "@@",
          newLineNumbers: [1],
          headStart: 1,
          headEnd: 1,
        };
        b.input.slices = [
          {
            id: "slice-1",
            title: "t",
            summary: "s",
            rationale: "r",
            fragments: [
              { ...fragment, kind: "core", lines: ["+a", "-b"] },
              { ...fragment, kind: "test", lines: ["+c"] },
            ],
          },
        ];
        return Promise.resolve(b);
      },
    });
    registry.add(ref(1));
    await registry.settled();
    expect(registry.get("a/b#1")!.size).toEqual({
      byKind: {
        core: { additions: 1, deletions: 1 },
        test: { additions: 1, deletions: 0 },
        boilerplate: { additions: 0, deletions: 0 },
      },
      total: { additions: 2, deletions: 1 },
    });
    registry.dispose();
  });

  it("drops a removed PR, even one still queued", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build, concurrency: 1 });
    registry.add(ref(1));
    registry.add(ref(2));
    await tick();
    expect(registry.remove("a/b#2")).toBe(true);
    expect(registry.remove("a/b#2")).toBe(false);
    pending.get(urlOf(1))!.resolve();
    await registry.settled();
    expect(registry.list().map((p) => p.key)).toEqual(["a/b#1"]);
    registry.dispose();
  });

  it("starts language services on the first question and lets them go on goodbye", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build, sessionGraceMs: 30 });
    registry.add(ref(1));
    await tick();
    pending.get(urlOf(1))!.resolve();
    await registry.settled();

    // Not built ≠ built-but-cold: an unknown key has no session to start.
    expect(registry.sessionFor("a/b#9")).toBeNull();
    expect(registry.get("a/b#1")?.live).toBe(false);
    const session = registry.sessionFor("a/b#1");
    expect(session).not.toBeNull();
    expect(registry.get("a/b#1")?.live).toBe(true);
    // The same session answers the next question.
    expect(registry.sessionFor("a/b#1")).toBe(session);

    // Goodbye then hello inside the grace: the session stays.
    registry.pageGone("a/b#1");
    registry.pageAlive("a/b#1");
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.get("a/b#1")?.live).toBe(true);

    // Goodbye alone: the session goes; the entry stays ready.
    registry.pageGone("a/b#1");
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.get("a/b#1")).toMatchObject({ live: false, state: "ready" });
    registry.dispose();
  });
});

describe("PrRegistry persistence", () => {
  let home: string;
  let dir: string;
  const persist = () => ({ store: fileStore(dir) });
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "registry-state-"));
    dir = path.join(home, "state", "prs");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** A build that counts how often it was asked, and finishes at once. */
  function countingBuild() {
    let calls = 0;
    const build = ({ prUrl, navBase }: { prUrl: string; navBase: string }) => {
      calls++;
      return Promise.resolve(built(Number(prUrl.split("/").pop()), navBase));
    };
    return { build, calls: () => calls };
  }

  it("brings a ready PR back in a fresh registry without building it again", async () => {
    const first = countingBuild();
    const registry = new PrRegistry({ build: first.build, persistence: persist() });
    registry.add(ref(1), { maxGraphs: 3 });
    await registry.settled();
    const before = registry.get("a/b#1")!;
    registry.dispose();
    expect(first.calls()).toBe(1);

    const second = countingBuild();
    const reloaded = new PrRegistry({ build: second.build, persistence: persist() });
    const after = reloaded.get("a/b#1");
    expect(second.calls()).toBe(0);
    expect(after).toMatchObject({
      key: "a/b#1",
      state: "ready",
      title: "PR 1",
      slices: 0,
      graphs: 0,
      path: "/pr/a/b/1/",
      addedAt: before.addedAt,
      readyAt: before.readyAt,
      live: false,
    });
    expect(reloaded.input("a/b#1")).toMatchObject({ prTitle: "PR 1", navBase: "/pr/a/b/1/" });
    // The PR is fully here: adding it again is the usual no-op, not a build.
    reloaded.add(ref(1));
    await reloaded.settled();
    expect(second.calls()).toBe(0);
    // What was written names the PR and what it was added with — and not the
    // page, which is derived and was 19 MB of the old state file.
    const files = readdirSync(dir);
    expect(files).toEqual(["a__b__1.json"]);
    const record = JSON.parse(readFileSync(path.join(dir, files[0]!), "utf8"));
    expect(record).toMatchObject({ version: 1, state: "ready", owner: "a", repo: "b", number: 1, options: { maxGraphs: 3 } });
    expect(record.built).not.toHaveProperty("html");
    reloaded.dispose();
  });

  it("forgets a removed PR on disk too, so a restart does not bring it back", async () => {
    const { build } = countingBuild();
    const registry = new PrRegistry({ build, persistence: persist() });
    registry.add(ref(1));
    registry.add(ref(2));
    await registry.settled();
    expect(readdirSync(dir)).toHaveLength(2);
    // The watcher does this when a PR is merged or closed. If the file still
    // held it, the next restart would put a finished PR back on the index.
    expect(registry.remove("a/b#1")).toBe(true);
    registry.dispose();

    const reloaded = new PrRegistry({ build, persistence: persist() });
    expect(reloaded.list().map((p) => p.key)).toEqual(["a/b#2"]);
    reloaded.dispose();
  });

  it.each([
    ["no directory", null],
    ["an empty file", ""],
    ["a file that is not JSON", "{ this is not"],
    ["JSON of the wrong shape", JSON.stringify({ prs: "many", version: 1 })],
  ])("starts empty given %s", (_name, contents) => {
    if (contents !== null) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "a__b__1.json"), contents);
    }
    const { build, calls } = countingBuild();
    const registry = new PrRegistry({ build, persistence: persist() });
    expect(registry.list()).toEqual([]);
    expect(calls()).toBe(0);
    registry.dispose();
  });

  it("skips a record it cannot trust rather than crashing on it later", async () => {
    const { build } = countingBuild();
    const registry = new PrRegistry({ build, persistence: persist() });
    registry.add(ref(1));
    await registry.settled();
    registry.dispose();
    writeFileSync(path.join(dir, "a__b__2.json"), JSON.stringify({ owner: "a", repo: "b", number: 2 }));
    writeFileSync(path.join(dir, "a__b__3.json"), "null");
    writeFileSync(path.join(dir, "notes.txt"), "not a record at all");

    const reloaded = new PrRegistry({ build, persistence: persist() });
    expect(reloaded.list().map((p) => p.key)).toEqual(["a/b#1"]);
    reloaded.dispose();
  });

  it("remembers ready and failed PRs, not what was still queued or building", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build, concurrency: 1, persistence: persist() });
    registry.add(ref(1));
    registry.add(ref(2));
    registry.add(ref(3));
    await tick();
    // 1 builds and fails; 2 builds and is ready; 3 is still building and 4
    // queued at the moment the last write happens.
    pending.get(urlOf(1))!.reject(new Error("no key"));
    await tick();
    pending.get(urlOf(2))!.resolve();
    await tick();
    registry.add(ref(4));
    await tick();
    expect(registry.list().map((p) => p.state)).toEqual(["failed", "ready", "building", "queued"]);
    registry.dispose();

    const next = countingBuild();
    const reloaded = new PrRegistry({ build: next.build, persistence: persist() });
    // The ready one is back as ready; the failed one is back as failed, with
    // its reason, rather than vanishing while the watcher believes it was
    // handed over. Nothing came back as ready without having been built.
    expect(reloaded.list().map((p) => [p.key, p.state])).toEqual([["a/b#1", "failed"], ["a/b#2", "ready"]]);
    expect(reloaded.get("a/b#1")).toMatchObject({ error: "no key" });
    expect(next.calls()).toBe(0);
    // Adding a failed PR again retries it; the building/queued ones are gone, so adding builds them.
    reloaded.add(ref(1));
    reloaded.add(ref(3));
    await reloaded.settled();
    expect(next.calls()).toBe(2);
    reloaded.dispose();
  });

  it("serves a restored page whose checkout has vanished, and fails only the question asked of it", async () => {
    const gone = path.join(home, "head");
    mkdirSync(gone);
    const build = ({ prUrl, navBase }: { prUrl: string; navBase: string }) =>
      Promise.resolve({ ...built(Number(prUrl.split("/").pop()), navBase), headDir: gone });
    const registry = new PrRegistry({ build, persistence: persist() });
    registry.add(ref(1));
    registry.add(ref(2));
    await registry.settled();
    registry.dispose();
    rmSync(gone, { recursive: true });

    const reloaded = new PrRegistry({ build, persistence: persist() });
    expect(reloaded.get("a/b#1")).toMatchObject({ state: "ready", title: "PR 1" });
    expect(() => reloaded.sessionFor("a/b#1")).toThrow(/head checkout for a\/b#1 is gone/);
    // Nothing else changed: the entry is still here and ready, not live, and
    // the other PR is untouched.
    expect(reloaded.get("a/b#1")).toMatchObject({ state: "ready", live: false });
    expect(reloaded.list().map((p) => p.key)).toEqual(["a/b#1", "a/b#2"]);
    expect(() => reloaded.sessionFor("a/b#2")).toThrow(/gone/);
    reloaded.dispose();
  });
});

describe("PrRegistry restore", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "registry-restore-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const quickBuild = ({ prUrl, navBase }: { prUrl: string; navBase: string }) =>
    Promise.resolve(built(Number(prUrl.split("/").pop()), navBase));

  it("brings a restored PR back ready, with the input its page is rendered from", async () => {
    const store = fileStore(path.join(home, "prs"));
    const registry = new PrRegistry({ build: quickBuild, persistence: { store } });
    registry.add(ref(1));
    await registry.settled();
    registry.dispose();

    const fresh = new PrRegistry({ build: quickBuild, persistence: { store } });
    expect(fresh.get("a/b#1")).toMatchObject({ state: "ready", title: "PR 1" });
    expect(fresh.input("a/b#1")).toMatchObject({ prTitle: "PR 1", navBase: "/pr/a/b/1/" });
    fresh.dispose();
  });
});

describe("PrRegistry retries", () => {
  const settle = () => new Promise((r) => setTimeout(r, 60));
  /** A build that fails with the given errors in order, then succeeds. */
  function failingBuild(errors: unknown[]) {
    let calls = 0;
    const build = ({ prUrl, navBase }: { prUrl: string; navBase: string }) => {
      const error = errors[calls++];
      if (error !== undefined) return Promise.reject(error);
      return Promise.resolve(built(Number(prUrl.split("/").pop()), navBase));
    };
    return { build, calls: () => calls };
  }
  const fast = { transientDelaysMs: [10, 10], transientMaxMs: 60_000, buildRetries: 1, buildDelayMs: 10 };

  it("retries a transient failure on the schedule, then reports the PR ready", async () => {
    const { build, calls } = failingBuild([new TransientError("socket reset"), new TransientError("again")]);
    const registry = new PrRegistry({ build, retry: fast });
    registry.add(ref(1));
    await tick();
    expect(registry.get("a/b#1")).toMatchObject({
      state: "failed",
      error: "socket reset",
      failure: { kind: "transient", attempts: 1, parked: false, nextRetryAt: expect.any(Number) },
    });
    await settle();
    expect(registry.get("a/b#1")).toMatchObject({ state: "ready" });
    expect(registry.get("a/b#1")!.failure).toBeUndefined();
    expect(calls()).toBe(3);
    registry.dispose();
  });

  it("gives a build failure one more go, then parks it", async () => {
    const { build, calls } = failingBuild([new BuildError("bad slices"), new BuildError("bad again"), new BuildError("never")]);
    const registry = new PrRegistry({ build, retry: fast });
    registry.add(ref(1));
    await tick();
    expect(registry.get("a/b#1")!.failure).toMatchObject({ kind: "build", attempts: 1, parked: false });
    await settle();
    expect(registry.get("a/b#1")).toMatchObject({ state: "failed", error: "bad again", failure: { attempts: 2, parked: true } });
    expect(registry.get("a/b#1")!.failure!.nextRetryAt).toBeUndefined();
    await settle();
    expect(calls()).toBe(2);
    registry.dispose();
  });

  it("parks config and input failures at once, saying why", async () => {
    const { build, calls } = failingBuild([new ConfigError("no token")]);
    const registry = new PrRegistry({ build, retry: fast });
    registry.add(ref(1));
    await tick();
    const view = registry.get("a/b#1")!;
    expect(view.failure).toMatchObject({ kind: "config", parked: true });
    expect(view.log.at(-1)).toMatch(/fix the setup/);
    await settle();
    expect(calls()).toBe(1);
    // An unrecognised error is a build failure by default, and is retried once.
    const other = failingBuild([new Error("something odd")]);
    const r2 = new PrRegistry({ build: other.build, retry: fast });
    r2.add(ref(2));
    await tick();
    expect(r2.get("a/b#2")!.failure).toMatchObject({ kind: "build", parked: false });
    registry.dispose();
    r2.dispose();
  });

  it("un-parks a failed PR when GitHub reports a new head, and keeps it parked otherwise", async () => {
    const { build, calls } = failingBuild([new InputError("diff too large")]);
    const registry = new PrRegistry({ build, retry: fast });
    registry.add(ref(1), {}, { headSha: "aaa" });
    await tick();
    expect(registry.get("a/b#1")!.failure).toMatchObject({ kind: "input", parked: true, headSha: "aaa" });
    registry.setFacts("a/b#1", { approved: true, headSha: "aaa" });
    await settle();
    expect(calls()).toBe(1);
    registry.setFacts("a/b#1", { headSha: "bbb" });
    await settle();
    expect(registry.get("a/b#1")).toMatchObject({ state: "ready" });
    expect(registry.get("a/b#1")!.failure).toBeUndefined();
    expect(calls()).toBe(2);
    registry.dispose();
  });

  it("retries transient and config failures after a restart, and leaves parked ones parked", async () => {
    const store = memoryStore();
    const persistence = { store };
    const first = failingBuild([new TransientError("net"), new ConfigError("key"), new InputError("big")]);
    const registry = new PrRegistry({ build: first.build, persistence, retry: { ...fast, transientDelaysMs: [60_000] } });
    registry.add(ref(1));
    registry.add(ref(2));
    registry.add(ref(3));
    await tick();
    expect(registry.list().map((p) => p.failure?.kind)).toEqual(["transient", "config", "input"]);
    registry.dispose();

    const second = failingBuild([]);
    const reloaded = new PrRegistry({ build: second.build, persistence, retry: fast });
    await reloaded.settled();
    expect(reloaded.list().map((p) => [p.key, p.state])).toEqual([["a/b#1", "ready"], ["a/b#2", "ready"], ["a/b#3", "failed"]]);
    expect(reloaded.get("a/b#3")!.failure).toMatchObject({ kind: "input", parked: true });
    expect(second.calls()).toBe(2);
    reloaded.dispose();
  });
});

describe("PrRegistry events", () => {
  it("tells listeners about every change to a PR, and when one goes", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build });
    const seen: string[] = [];
    const stop = registry.subscribe((e) => seen.push(e.type === "pr" ? `${e.pr.key}:${e.pr.state}` : `removed:${e.key}`));
    registry.add(ref(1));
    await tick();
    registry.setFacts("a/b#1", { approved: true });
    pending.get(urlOf(1))!.resolve();
    await tick();
    registry.remove("a/b#1");
    // Queued first, then building (once per log line too), then ready, then gone.
    expect(seen[0]).toBe("a/b#1:queued");
    expect(seen.slice(1, -2).every((s) => s === "a/b#1:building")).toBe(true);
    expect(seen.slice(1, -2).length).toBeGreaterThanOrEqual(2);
    expect(seen.slice(-2)).toEqual(["a/b#1:ready", "removed:a/b#1"]);
    // Unsubscribed, nothing more arrives; a listener that throws does not stop the others.
    const count = seen.length;
    stop();
    registry.subscribe(() => {
      throw new Error("boom");
    });
    const after: string[] = [];
    registry.subscribe((e) => after.push(e.type));
    registry.add(ref(2));
    expect(seen).toHaveLength(count);
    // Queued, and — the build starting at once — building.
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after.every((t) => t === "pr")).toBe(true);
    registry.dispose();
  });

  it("hands out a ready PR's input, and nothing before that", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build });
    registry.add(ref(1));
    await tick();
    expect(registry.input("a/b#1")).toBeNull();
    pending.get(urlOf(1))!.resolve();
    await tick();
    expect(registry.input("a/b#1")).toMatchObject({ prTitle: "PR 1", navBase: "/pr/a/b/1/" });
    expect(registry.input("a/b#9")).toBeNull();
    registry.dispose();
  });
});

describe("PrRegistry checkouts", () => {
  const quickBuild = ({ prUrl, navBase }: { prUrl: string; navBase: string }) =>
    Promise.resolve({ ...built(Number(prUrl.split("/").pop()), navBase), headSha: `h${prUrl.slice(-1)}`, baseSha: "base" });

  it("tells the cleanup hook what a dropped PR held and what every other PR still holds", async () => {
    const calls: [unknown, unknown][] = [];
    const registry = new PrRegistry({ build: quickBuild, onRemoved: (removed, remaining) => calls.push([removed, remaining]) });
    registry.add(ref(1));
    registry.add(ref(2));
    await registry.settled();
    expect(registry.checkouts()).toEqual([
      { owner: "a", repo: "b", number: 1, headDir, headSha: "h1", baseSha: "base" },
      { owner: "a", repo: "b", number: 2, headDir, headSha: "h2", baseSha: "base" },
    ]);
    registry.remove("a/b#1");
    expect(calls).toEqual([
      [
        { owner: "a", repo: "b", number: 1, headDir, headSha: "h1", baseSha: "base" },
        [{ owner: "a", repo: "b", number: 2, headDir, headSha: "h2", baseSha: "base" }],
      ],
    ]);
    // A hook that throws does not stop the removal.
    const angry = new PrRegistry({ build: quickBuild, onRemoved: () => { throw new Error("disk on fire"); } });
    angry.add(ref(3));
    await angry.settled();
    expect(angry.remove("a/b#3")).toBe(true);
    expect(angry.list()).toEqual([]);
    registry.dispose();
    angry.dispose();
  });
});

describe("PrRegistry facts", () => {
  let home: string;
  let persistence: { store: ReturnType<typeof fileStore> };
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "registry-facts-"));
    persistence = { store: fileStore(path.join(home, "prs")) };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const quickBuild = ({ prUrl, navBase }: { prUrl: string; navBase: string }) =>
    Promise.resolve(built(Number(prUrl.split("/").pop()), navBase));

  it("takes a PR's role and approval when it is added, and defaults them when it is not told", async () => {
    const registry = new PrRegistry({ build: quickBuild });
    registry.add(ref(1), {}, { role: "authored", author: "me", draft: true });
    registry.add(ref(2));
    await registry.settled();
    expect(registry.get("a/b#1")).toMatchObject({ role: "authored", author: "me", draft: true, approved: false, approvers: [] });
    expect(registry.get("a/b#2")).toMatchObject({ role: "review", approved: false, approvers: [] });
    registry.dispose();
  });

  it("updates the facts of a held PR without rebuilding it, and says only what changed", async () => {
    let calls = 0;
    const log: string[] = [];
    const registry = new PrRegistry({
      build: (request) => {
        calls++;
        return quickBuild(request);
      },
      onProgress: (m) => log.push(m),
    });
    registry.add(ref(1));
    await registry.settled();
    expect(registry.setFacts("a/b#1", { approved: true, approvers: ["alex"] })).toMatchObject({
      approved: true,
      approvers: ["alex"],
      role: "review",
    });
    // A field left undefined is no news, not a reset.
    expect(registry.setFacts("a/b#1", { role: "authored" })).toMatchObject({ approved: true, role: "authored" });
    expect(registry.setFacts("a/b#9", { approved: true })).toBeNull();
    // Re-adding a held PR takes the facts too, and is still not a build.
    registry.add(ref(1), {}, { approved: false });
    await registry.settled();
    expect(registry.get("a/b#1")!.approved).toBe(false);
    expect(calls).toBe(1);
    expect(log.filter((m) => /approved/.test(m))).toEqual(["a/b#1: approved by alex.", "a/b#1: no longer approved."]);
    registry.dispose();
  });

  it("keeps the facts across a restart, so a PR stays on its tab", async () => {
    const registry = new PrRegistry({ build: quickBuild, persistence });
    registry.add(ref(1), {}, { role: "authored", author: "me" });
    await registry.settled();
    registry.setFacts("a/b#1", { approved: true, approvers: ["alex"] });
    registry.dispose();
    const reloaded = new PrRegistry({ build: quickBuild, persistence });
    expect(reloaded.get("a/b#1")).toMatchObject({
      state: "ready",
      role: "authored",
      author: "me",
      approved: true,
      approvers: ["alex"],
    });
    reloaded.dispose();
  });
});
