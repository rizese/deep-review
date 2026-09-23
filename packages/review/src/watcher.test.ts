import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssignedPr, PrRef, PrSearch } from "@deep-review/pr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddOptions, PrView } from "./registry.js";
import { searchesForRepo, watchConfigFile, type WatchConfig } from "./watchConfig.js";
import {
  parsePrKey,
  planCleanup,
  planPoll,
  pollOnce,
  readWatcherState,
  watcherStateFile,
  writeWatcherState,
  type PrLifecycle,
  type SeenPr,
} from "./watcher.js";

function assigned(number: number, updatedAt = "2026-09-01T10:00:00Z"): AssignedPr {
  return {
    owner: "acme",
    repo: "widgets",
    number,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/acme/widgets/pull/${number}`,
    updatedAt,
    draft: false,
    role: "review",
    author: "someone",
    approved: false,
    approvers: [],
    headSha: "h",
  };
}

/** Narrow watch.json, under the test's state dir, to these repos. */
function watching(...repos: (string | [string, string])[]): void {
  const config: WatchConfig = { searches: { review: [], authored: [] } };
  for (const entry of repos) {
    const pair = typeof entry === "string" ? searchesForRepo(entry) : searchesForRepo(entry[0], entry[1]);
    config.searches.review.push(...pair.review);
    config.searches.authored.push(...pair.authored);
  }
  writeConfig(config);
}

/** Write watch.json as given. */
function writeConfig(config: unknown): void {
  mkdirSync(path.dirname(watchConfigFile()), { recursive: true });
  writeFileSync(watchConfigFile(), JSON.stringify(config));
}

function view(pr: AssignedPr): PrView {
  return {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    prUrl: pr.htmlUrl,
    key: `${pr.owner}/${pr.repo}#${pr.number}`,
    state: "queued",
    role: pr.role,
    approved: pr.approved,
    approvers: pr.approvers,
    path: `/pr/${pr.owner}/${pr.repo}/${pr.number}/`,
    addedAt: Date.now(),
    log: [],
    live: false,
  };
}

describe("planPoll", () => {
  it("dispatches a PR the first time it is seen", () => {
    const { dispatch, seen } = planPoll([assigned(1)], {});
    expect(dispatch.map((pr) => pr.number)).toEqual([1]);
    expect(Object.keys(seen)).toEqual(["acme/widgets#1"]);
  });

  it("does not dispatch again when the PR merely changed", () => {
    const before: Record<string, SeenPr> = {
      "acme/widgets#1": { updatedAt: "2026-09-01T10:00:00Z", dispatchedAt: 1 },
    };
    // A comment moves updated_at; re-slicing for that would cost a model call.
    const { dispatch, seen } = planPoll([assigned(1, "2026-09-02T18:00:00Z")], before);
    expect(dispatch).toEqual([]);
    expect(seen["acme/widgets#1"]).toEqual(before["acme/widgets#1"]);
  });

  it("forgets a PR that is no longer assigned, so reassigning asks again", () => {
    const before: Record<string, SeenPr> = {
      "acme/widgets#1": { updatedAt: "2026-09-01T10:00:00Z", dispatchedAt: 1 },
    };
    expect(planPoll([], before).seen).toEqual({});
    expect(planPoll([assigned(1)], planPoll([], before).seen).dispatch).toHaveLength(1);
  });

  it("dispatches only the new PR when others are already known", () => {
    const before = planPoll([assigned(1)], {}).seen;
    const { dispatch } = planPoll([assigned(1), assigned(2)], before);
    expect(dispatch.map((pr) => pr.number)).toEqual([2]);
  });
});

describe("pollOnce", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
    process.env.DEEP_REVIEW_HOME = home;
    watching("acme/widgets");
  });

  afterEach(() => {
    delete process.env.DEEP_REVIEW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("hands new PRs over and remembers them", async () => {
    const handed: number[] = [];
    const state = await pollOnce({
      search: async () => [assigned(1), assigned(2)],
      add: async (pr) => {
        handed.push(pr.number);
        return view(pr);
      },
    });
    expect(handed).toEqual([1, 2]);
    expect(Object.keys(state.seen)).toHaveLength(2);
    expect(readWatcherState().seen).toEqual(state.seen);
  });

  it("hands a PR over with what GitHub said about it: its role and approval", async () => {
    const facts: unknown[] = [];
    await pollOnce({
      search: async () => [
        { ...assigned(1), role: "authored", author: "me", draft: true },
        { ...assigned(2), approved: true, approvers: ["alex"] },
      ],
      add: async (pr, _options, given) => {
        facts.push(given);
        return view(pr);
      },
    });
    expect(facts).toEqual([
      { role: "authored", approved: false, approvers: [], author: "me", draft: true, headSha: "h" },
      { role: "review", approved: true, approvers: ["alex"], author: "someone", draft: false, headSha: "h" },
    ]);
  });

  it("refreshes what the server knows about PRs it already holds, without handing them over again", async () => {
    // An approval lands after the page is built, and the page should say so
    // — but a re-add would rebuild on every push, so the facts go separately.
    const handed: number[] = [];
    const refreshed: [string, unknown][] = [];
    const deps = {
      search: async () => [assigned(1)],
      add: async (pr: AssignedPr) => {
        handed.push(pr.number);
        return view(pr);
      },
      update: async (key: string, facts: unknown) => {
        refreshed.push([key, facts]);
        return true;
      },
    };
    await pollOnce(deps);
    expect(refreshed).toEqual([]);
    await pollOnce({ ...deps, search: async () => [{ ...assigned(1), approved: true, approvers: ["alex"] }] });
    expect(handed).toEqual([1]);
    expect(refreshed).toEqual([
      ["acme/widgets#1", { role: "review", approved: true, approvers: ["alex"], author: "someone", draft: false, headSha: "h" }],
    ]);
  });

  it("does not hand the same PR over twice across polls", async () => {
    const handed: number[] = [];
    const deps = {
      search: async () => [assigned(1)],
      add: async (pr: AssignedPr) => {
        handed.push(pr.number);
        return view(pr);
      },
    };
    await pollOnce(deps);
    await pollOnce(deps);
    expect(handed).toEqual([1]);
  });

  it("retries next poll when the handover failed", async () => {
    let attempts = 0;
    const deps = {
      search: async () => [assigned(1)],
      add: async (pr: AssignedPr) => {
        attempts += 1;
        if (attempts === 1) throw new Error("server down");
        return view(pr);
      },
    };
    const first = await pollOnce(deps);
    // A PR lost to one bad minute must not be remembered as delivered.
    expect(first.seen).toEqual({});
    await pollOnce(deps);
    expect(attempts).toBe(2);
    expect(Object.keys(readWatcherState().seen)).toEqual(["acme/widgets#1"]);
  });

  it("keeps what it knew when GitHub cannot be reached", async () => {
    await pollOnce({ search: async () => [assigned(1)], add: async (pr) => view(pr) });
    const state = await pollOnce({
      search: async () => {
        throw new Error("offline");
      },
    });
    expect(state.lastError).toBe("offline");
    expect(Object.keys(state.seen)).toEqual(["acme/widgets#1"]);
  });

  it("writes state as readable JSON under the state dir", async () => {
    await pollOnce({ search: async () => [assigned(7)], add: async (pr) => view(pr) });
    expect(watcherStateFile()).toBe(path.join(home, "watcher.json"));
    expect(JSON.parse(readFileSync(watcherStateFile(), "utf8")).seen).toHaveProperty(
      "acme/widgets#7",
    );
  });

  it("leaves the work dir to the daemon, which keys one per PR", async () => {
    // A single shared work dir would put the clones and checkouts of two
    // concurrently building PRs on top of each other.
    let handed: AddOptions | undefined;
    await pollOnce({
      search: async () => [assigned(1)],
      add: async (pr, options) => {
        handed = options;
        return view(pr);
      },
    });
    expect(handed).toBeDefined();
  });

  it("survives a corrupt state file rather than refusing to start", () => {
    writeWatcherState({
      seen: { "acme/widgets#1": { updatedAt: "x", dispatchedAt: 1 } },
      held: {},
    });
    expect(readWatcherState().seen).toHaveProperty("acme/widgets#1");
  });

  it("reads a state file written before `held` existed, and holds what it saw", () => {
    // There is a live watcher.json on any machine that ran the watcher before
    // this field; it must load, and the PRs it had handed over must be looked
    // after — they are on the server, and only `seen` knows it.
    mkdirSync(home, { recursive: true });
    writeFileSync(
      watcherStateFile(),
      JSON.stringify({
        seen: { "acme/widgets#1": { updatedAt: "x", dispatchedAt: 1 } },
        lastPollAt: 5,
      }),
    );
    const state = readWatcherState();
    expect(Object.keys(state.held)).toEqual(["acme/widgets#1"]);
    expect(state.seen).toEqual(state.held);
    expect(state.lastPollAt).toBe(5);
  });
});

describe("parsePrKey", () => {
  it("turns a key back into the ref that made it", () => {
    expect(parsePrKey("acme/widgets#12")).toEqual({ owner: "acme", repo: "widgets", number: 12 });
  });

  it("refuses a key of another shape rather than guessing", () => {
    expect(parsePrKey("nonsense")).toBeNull();
  });
});

const OPEN: PrLifecycle = { state: "open", merged: false };
const MERGED: PrLifecycle = { state: "closed", merged: true };
const CLOSED: PrLifecycle = { state: "closed", merged: false };

function heldPr(): SeenPr {
  return { updatedAt: "2026-09-01T10:00:00Z", dispatchedAt: 1 };
}

describe("planCleanup", () => {
  it("finishes a held PR that has been merged", async () => {
    const { finished, held } = await planCleanup(
      { "acme/widgets#1": heldPr() },
      [],
      async () => MERGED,
    );
    expect(finished).toEqual(["acme/widgets#1"]);
    expect(held).toEqual({});
  });

  it("finishes a held PR that was closed without merging", async () => {
    // Closed-unmerged is as done as merged: nothing on that page is going in.
    const { finished } = await planCleanup({ "acme/widgets#1": heldPr() }, [], async () => CLOSED);
    expect(finished).toEqual(["acme/widgets#1"]);
  });

  it("keeps a PR that left the review query but is still open", async () => {
    // Approval removes a PR from the query, and so does unassigning it or
    // turning it back into a draft; none of those finish it. Only GitHub's
    // own state may, so a PR that is gone from the query yet still open stays.
    const { finished, held } = await planCleanup(
      { "acme/widgets#1": heldPr() },
      [],
      async () => OPEN,
    );
    expect(finished).toEqual([]);
    expect(Object.keys(held)).toEqual(["acme/widgets#1"]);
  });

  it("does not ask about PRs the query still lists, which are open by definition", async () => {
    const asked: PrRef[] = [];
    await planCleanup({ "acme/widgets#1": heldPr(), "acme/widgets#2": heldPr() }, [assigned(1)], async (ref) => {
      asked.push(ref);
      return OPEN;
    });
    expect(asked.map((ref) => ref.number)).toEqual([2]);
  });

  it("asks about a still-open PR again only after a while, not every poll", async () => {
    // Approved-but-open PRs sit outside the query for days; asking GitHub
    // about each of them every five minutes was the watcher's biggest cost.
    const asked: number[] = [];
    const check = async (ref: PrRef) => {
      asked.push(ref.number);
      return OPEN;
    };
    const t0 = 1_000_000;
    const first = await planCleanup({ "acme/widgets#1": heldPr() }, [], check, () => {}, { now: t0, recheckMs: 600 });
    expect(asked).toEqual([1]);
    expect(first.held["acme/widgets#1"]!.checkedAt).toBe(t0);
    // Too soon: not asked. Late enough: asked, and the time moves on.
    await planCleanup(first.held, [], check, () => {}, { now: t0 + 500, recheckMs: 600 });
    expect(asked).toEqual([1]);
    const third = await planCleanup(first.held, [], check, () => {}, { now: t0 + 700, recheckMs: 600 });
    expect(asked).toEqual([1, 1]);
    expect(third.held["acme/widgets#1"]!.checkedAt).toBe(t0 + 700);
    // Once it is merged, the wait does not save it.
    const done = await planCleanup(third.held, [], async () => MERGED, () => {}, { now: t0 + 100_000, recheckMs: 600 });
    expect(done.finished).toEqual(["acme/widgets#1"]);
  });

  it("keeps a PR whose check failed, and finishes the others", async () => {
    // A failed check proves nothing either way; the safe reading is "still
    // open", and the next poll asks again.
    const { finished, held } = await planCleanup(
      { "acme/widgets#1": heldPr(), "acme/widgets#2": heldPr() },
      [],
      async (ref) => {
        if (ref.number === 1) throw new Error("502");
        return MERGED;
      },
    );
    expect(finished).toEqual(["acme/widgets#2"]);
    expect(Object.keys(held)).toEqual(["acme/widgets#1"]);
  });
});

describe("pollOnce cleanup", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
    process.env.DEEP_REVIEW_HOME = home;
    watching("acme/widgets");
  });

  afterEach(() => {
    delete process.env.DEEP_REVIEW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  /** Hand PR 1 over on one poll, so a later poll has something to clean up. */
  async function handOver(): Promise<void> {
    await pollOnce({
      search: async () => [assigned(1)],
      add: async (pr) => view(pr),
      check: async () => OPEN,
    });
    expect(Object.keys(readWatcherState().held)).toEqual(["acme/widgets#1"]);
  }

  it("removes a merged PR from the server and forgets it", async () => {
    await handOver();
    const removed: string[] = [];
    const state = await pollOnce({
      search: async () => [],
      check: async () => MERGED,
      remove: async (key) => {
        removed.push(key);
        return true;
      },
    });
    expect(removed).toEqual(["acme/widgets#1"]);
    expect(state.held).toEqual({});
    expect(state.seen).toEqual({});
    expect(readWatcherState().held).toEqual({});
  });

  it("removes a PR closed without merging", async () => {
    await handOver();
    const removed: string[] = [];
    await pollOnce({
      search: async () => [],
      check: async () => CLOSED,
      remove: async (key) => {
        removed.push(key);
        return true;
      },
    });
    expect(removed).toEqual(["acme/widgets#1"]);
  });

  it("leaves an approved PR on the server, held, though it left the query", async () => {
    await handOver();
    const removed: string[] = [];
    const state = await pollOnce({
      search: async () => [],
      check: async () => OPEN,
      remove: async (key) => {
        removed.push(key);
        return true;
      },
    });
    expect(removed).toEqual([]);
    // Out of `seen` — the query no longer lists it — but still held.
    expect(state.seen).toEqual({});
    expect(Object.keys(state.held)).toEqual(["acme/widgets#1"]);
  });

  it("neither crashes nor removes anything when the check errors", async () => {
    await handOver();
    const removed: string[] = [];
    const state = await pollOnce({
      search: async () => [],
      check: async () => {
        throw new Error("GitHub 502");
      },
      remove: async (key) => {
        removed.push(key);
        return true;
      },
    });
    expect(removed).toEqual([]);
    expect(Object.keys(state.held)).toEqual(["acme/widgets#1"]);
    expect(state.lastError).toBeUndefined();
  });

  it("still forgets a finished PR when the server could not be told", async () => {
    // The server's registry is in memory: one that is not running holds
    // nothing, and one that will not answer is not this poll's to fix.
    await handOver();
    const state = await pollOnce({
      search: async () => [],
      check: async () => MERGED,
      remove: async () => {
        throw new Error("connection refused");
      },
    });
    expect(state.held).toEqual({});
  });

  it("does not hold a PR whose handover failed", async () => {
    // Nothing reached the server, so there is nothing there to clean up.
    const state = await pollOnce({
      search: async () => [assigned(1)],
      add: async () => {
        throw new Error("server down");
      },
      check: async () => OPEN,
    });
    expect(state.held).toEqual({});
  });
});

describe("pollOnce across searches", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
    process.env.DEEP_REVIEW_HOME = home;
  });

  afterEach(() => {
    delete process.env.DEEP_REVIEW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  function inRepo(repo: string, number: number): AssignedPr {
    const [owner, name] = repo.split("/") as [string, string];
    return { ...assigned(number), owner, repo: name, htmlUrl: `https://github.com/${repo}/pull/${number}` };
  }

  /**
   * A fake GitHub holding PRs by repo, answering only what a search asks
   * for: a query naming `repo:x/y` gets x/y's PRs, and a query naming no
   * repo gets everything — which is exactly what the real search does, and
   * why an unbounded one is refused before it is ever sent.
   */
  function github(prs: Record<string, AssignedPr[]>) {
    const asked: PrSearch[] = [];
    const search = async (searches: PrSearch[]): Promise<AssignedPr[]> => {
      asked.push(...searches);
      const found = new Map<string, AssignedPr>();
      for (const one of searches) {
        const named = /repo:(\S+)/.exec(one.query)?.[1];
        for (const [repo, list] of Object.entries(prs)) {
          if (named && named !== repo) continue;
          for (const pr of list) found.set(`${pr.owner}/${pr.repo}#${pr.number}`, { ...pr, role: one.role });
        }
      }
      return [...found.values()];
    };
    return { asked, search };
  }

  it("runs every configured search in one call and holds what they all find", async () => {
    watching(["acme/widgets", "is:open is:pr review-requested:@me"], ["acme/gadgets", "is:open is:pr label:needs-review"]);
    const gh = github({
      "acme/widgets": [inRepo("acme/widgets", 1)],
      "acme/gadgets": [inRepo("acme/gadgets", 9)],
    });
    const handed: string[] = [];
    const state = await pollOnce({
      search: gh.search,
      add: async (pr) => {
        handed.push(`${pr.owner}/${pr.repo}#${pr.number}`);
        return view(pr);
      },
      check: async () => OPEN,
    });
    expect(gh.asked.filter((one) => one.role === "review").map((one) => one.query)).toEqual([
      "is:open is:pr review-requested:@me repo:acme/widgets",
      "is:open is:pr label:needs-review repo:acme/gadgets",
    ]);
    expect(handed.sort()).toEqual(["acme/gadgets#9", "acme/widgets#1"]);
    expect(Object.keys(state.seen).sort()).toEqual(["acme/gadgets#9", "acme/widgets#1"]);
    expect(Object.keys(state.held).sort()).toEqual(["acme/gadgets#9", "acme/widgets#1"]);
  });

  it("asks for nothing a search did not name", async () => {
    // The incident the old repo list existed for: an unbounded search
    // returns every PR the token can see, and six from a personal repo
    // nobody meant to watch landed on the server. Narrowing is now the
    // search's job, and a narrowed one reaches no further than it says.
    watching("acme/widgets");
    const gh = github({
      "acme/widgets": [inRepo("acme/widgets", 1)],
      "elsewhere/panoply": [inRepo("elsewhere/panoply", 3), inRepo("elsewhere/panoply", 4)],
    });
    const handed: string[] = [];
    const state = await pollOnce({
      search: gh.search,
      add: async (pr) => {
        handed.push(`${pr.owner}/${pr.repo}#${pr.number}`);
        return view(pr);
      },
      check: async () => OPEN,
    });
    expect(gh.asked.every((one) => one.query.includes("repo:acme/widgets"))).toBe(true);
    expect(handed).toEqual(["acme/widgets#1"]);
    expect(Object.keys(state.held)).toEqual(["acme/widgets#1"]);
  });

  it("asks both of the default questions when there is no file", async () => {
    // A fresh install has no file, and that no longer means "watch
    // nothing": it means the searches that name you. They are bound by
    // `@me`, so the widest they can reach is your own PRs.
    const gh = github({});
    const messages: string[] = [];
    const state = await pollOnce({ search: gh.search, onProgress: (m) => messages.push(m) });
    const queries = gh.asked.map((one) => one.query);
    expect(queries.some((q) => q.includes("assignee:@me"))).toBe(true);
    expect(queries.some((q) => q.includes("review-requested:@me"))).toBe(true);
    expect(gh.asked.filter((one) => one.role === "authored").map((one) => one.query)).toEqual([
      "is:open is:pr archived:false author:@me",
    ]);
    expect(state.lastError).toBeUndefined();
  });

  it("reads an old repo-list file as the searches it stood for, and says so", async () => {
    // Upgrading must watch what it watched yesterday, not suddenly
    // everything; the repos become repo-scoped searches.
    writeConfig({ repos: { "acme/widgets": {} } });
    const gh = github({ "acme/widgets": [inRepo("acme/widgets", 1)], "elsewhere/panoply": [inRepo("elsewhere/panoply", 3)] });
    const messages: string[] = [];
    await pollOnce({ search: gh.search, add: async (pr) => view(pr), check: async () => OPEN, onProgress: (m) => messages.push(m) });
    expect(gh.asked.every((one) => one.query.includes("repo:acme/widgets"))).toBe(true);
    expect(messages.join("\n")).toMatch(/still lists repos/);
  });

  it("survives a corrupt config file, saying why and falling back to the searches that name you", async () => {
    // A typo must not take the watcher down: a crashed watcher also stops
    // removing merged PRs from the server.
    writeFileSync(watchConfigFile(), "{ this is not json");
    const gh = github({});
    const messages: string[] = [];
    const state = await pollOnce({ search: gh.search, onProgress: (m) => messages.push(m) });
    expect(messages.join("\n")).toMatch(/could not be read/);
    expect(gh.asked.some((one) => one.query.includes("@me"))).toBe(true);
    expect(state.lastError).toBeUndefined();
  });

  it("skips a search bound to nobody and nowhere, and runs the rest", async () => {
    // Left in, it would answer with every PR the token can see.
    writeConfig({ searches: { review: ["is:open is:pr", "is:open is:pr repo:acme/gadgets"], authored: [] } });
    const gh = github({});
    const messages: string[] = [];
    await pollOnce({ search: gh.search, onProgress: (m) => messages.push(m) });
    expect(gh.asked.map((one) => one.query)).toEqual(["is:open is:pr repo:acme/gadgets"]);
    expect(messages.join("\n")).toMatch(/names nobody and nowhere/);
  });

  it("keeps what it knew when the poll fails, rather than emptying the list", async () => {
    // Partial results would make PRs look gone: they would leave `seen` for
    // a GitHub hiccup, then re-dispatch when it came back.
    watching("acme/widgets");
    await pollOnce({
      search: async () => [inRepo("acme/widgets", 1)],
      add: async (pr) => view(pr),
      check: async () => OPEN,
    });
    const state = await pollOnce({
      search: async () => {
        throw new Error("422");
      },
    });
    expect(state.lastError).toBe("422");
    expect(Object.keys(state.seen)).toEqual(["acme/widgets#1"]);
  });

  it("still cleans up held PRs when the searches no longer find them", async () => {
    // A PR handed over is on the server whatever the file now says;
    // narrowing the search should not strand its page there forever.
    watching("acme/widgets");
    await pollOnce({
      search: async () => [inRepo("acme/widgets", 1)],
      add: async (pr) => view(pr),
      check: async () => OPEN,
    });
    watching("acme/gadgets");
    const removed: string[] = [];
    const state = await pollOnce({
      search: async () => [],
      check: async () => MERGED,
      remove: async (key) => {
        removed.push(key);
        return true;
      },
    });
    expect(removed).toEqual(["acme/widgets#1"]);
    expect(state.held).toEqual({});
  });
});
