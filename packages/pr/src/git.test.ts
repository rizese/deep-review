import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeepReviewError } from "./errors.js";
import type { PrInfo } from "./github.js";
import {
  prepareCheckouts,
  releaseCheckouts,
  removeRepoWorkDir,
  repoWorkRoot,
} from "./git.js";

/**
 * Real git against a real repository on disk — the whole point of this module
 * is what git does with clones and worktrees, and a mock of git would only
 * assert that we remembered what we wrote. Nothing here touches the network:
 * the "remote" is a `file://` path in the temp dir.
 */

let scratch: string;
let origin: string;
let shas: string[];

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Keep the developer's own git config out of the fixture.
      GIT_CONFIG_GLOBAL: path.join(scratch, "gitconfig"),
      GIT_CONFIG_SYSTEM: path.join(scratch, "gitconfig"),
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/** A PR of the fixture repo: `base` is where it branched, `head` its tip. */
function prInfo(number: number, baseSha: string, headSha: string): PrInfo {
  return {
    owner: "acme",
    repo: "widget",
    number,
    title: `pr ${number}`,
    body: "",
    author: "someone",
    baseRef: "main",
    baseSha,
    headRef: `feature-${number}`,
    headSha,
    cloneUrl: `file://${origin}`,
    htmlUrl: `https://github.com/acme/widget/pull/${number}`,
    state: "open",
    merged: false,
  };
}

function worktreeNames(repoRoot: string): string[] {
  const dir = path.join(repoRoot, "wt");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "deep-review-git-test-"));
  writeFileSync(path.join(scratch, "gitconfig"), "", "utf8");
  origin = path.join(scratch, "origin");
  mkdirSync(origin);
  git(["init", "-b", "main"], origin);
  shas = [];
  for (const [file, text] of [
    ["one.txt", "one\n"],
    ["two.txt", "two\n"],
    ["three.txt", "three\n"],
  ] as const) {
    writeFileSync(path.join(origin, file), text, "utf8");
    git(["add", "."], origin);
    git(["commit", "-m", `add ${file}`], origin);
    shas.push(git(["rev-parse", "HEAD"], origin).trim());
  }
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("prepareCheckouts", () => {
  it("clones once and checks out the merge base and the head", () => {
    const root = repoWorkRoot(path.join(scratch, "work-one"), { owner: "acme", repo: "widget" });
    expect(root).toBe(path.join(scratch, "work-one", "acme", "widget"));

    const checkouts = prepareCheckouts(prInfo(1, shas[0] as string, shas[1] as string), root);

    expect(checkouts.mergeBaseSha).toBe(shas[0]);
    expect(checkouts.baseDir).toBe(path.join(root, "wt", shas[0] as string));
    expect(checkouts.headDir).toBe(path.join(root, "wt", shas[1] as string));
    expect(existsSync(path.join(checkouts.baseDir, "one.txt"))).toBe(true);
    expect(existsSync(path.join(checkouts.baseDir, "two.txt"))).toBe(false);
    expect(existsSync(path.join(checkouts.headDir, "two.txt"))).toBe(true);
    expect(checkouts.diffText).toContain("two.txt");

    expect(existsSync(path.join(root, "repo"))).toBe(true);
    expect(worktreeNames(root)).toEqual([shas[0], shas[1]].sort());
  });

  it("reuses the clone and shares a base worktree across two PRs of one repo", () => {
    const root = repoWorkRoot(path.join(scratch, "work-two"), { owner: "acme", repo: "widget" });
    const first = prepareCheckouts(prInfo(1, shas[0] as string, shas[1] as string), root);
    const second = prepareCheckouts(prInfo(2, shas[0] as string, shas[2] as string), root);

    // One clone for both PRs, and the shared merge base is one worktree.
    expect(readdirSync(root).sort()).toEqual(["repo", "wt"]);
    expect(second.baseDir).toBe(first.baseDir);
    expect(second.headDir).not.toBe(first.headDir);
    expect(worktreeNames(root)).toEqual([shas[0], shas[1], shas[2]].sort());
    // The first PR's head worktree is untouched by the second PR's prepare.
    expect(existsSync(path.join(first.headDir, "two.txt"))).toBe(true);
    expect(existsSync(path.join(first.headDir, "three.txt"))).toBe(false);
    expect(existsSync(path.join(second.headDir, "three.txt"))).toBe(true);
  });

  it("rebuilds a worktree whose directory has been broken", () => {
    const root = repoWorkRoot(path.join(scratch, "work-broken"), { owner: "acme", repo: "widget" });
    const info = prInfo(1, shas[0] as string, shas[1] as string);
    const first = prepareCheckouts(info, root);

    // A worktree that no longer answers rev-parse: its .git pointer is junk.
    writeFileSync(path.join(first.headDir, ".git"), "not a worktree\n", "utf8");
    rmSync(path.join(first.headDir, "two.txt"), { force: true });

    const again = prepareCheckouts(info, root);
    expect(again.headDir).toBe(first.headDir);
    expect(existsSync(path.join(again.headDir, "two.txt"))).toBe(true);
    expect(git(["rev-parse", "HEAD"], again.headDir).trim()).toBe(shas[1]);
  });
});

describe("releaseCheckouts", () => {
  it("removes the worktrees nobody kept and leaves the listed ones alone", () => {
    const root = repoWorkRoot(path.join(scratch, "work-release"), { owner: "acme", repo: "widget" });
    prepareCheckouts(prInfo(1, shas[0] as string, shas[1] as string), root);
    prepareCheckouts(prInfo(2, shas[0] as string, shas[2] as string), root);
    expect(worktreeNames(root)).toHaveLength(3);

    const { removed } = releaseCheckouts(root, { shas: [shas[0] as string, shas[2] as string] });

    expect(removed).toEqual([path.join(root, "wt", shas[1] as string)]);
    expect(worktreeNames(root)).toEqual([shas[0], shas[2]].sort());
    expect(existsSync(path.join(root, "repo"))).toBe(true);
    // git no longer believes in the one we took away.
    expect(git(["worktree", "list", "--porcelain"], path.join(root, "repo"))).not.toContain(
      shas[1] as string,
    );

    // A released commit can be prepared again afterwards.
    const back = prepareCheckouts(prInfo(1, shas[0] as string, shas[1] as string), root);
    expect(existsSync(path.join(back.headDir, "two.txt"))).toBe(true);

    removeRepoWorkDir(root);
    expect(existsSync(root)).toBe(false);
  });

  it("is a no-op on a root that was never prepared", () => {
    expect(releaseCheckouts(path.join(scratch, "nothing-here"), { shas: [] })).toEqual({
      removed: [],
    });
  });
});

describe("git failures", () => {
  it("classifies a clone URL that serves no repository", () => {
    const root = repoWorkRoot(path.join(scratch, "work-bogus"), { owner: "acme", repo: "ghost" });
    const info = prInfo(1, shas[0] as string, shas[1] as string);
    let thrown: unknown;
    try {
      prepareCheckouts({ ...info, cloneUrl: `file://${path.join(scratch, "no-such-repo")}` }, root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeepReviewError);
    const error = thrown as DeepReviewError;
    // git says "does not appear to be a git repository" / "Could not read from
    // remote repository": the URL is wrong, not the network.
    expect(error.kind).toBe("config");
    expect(error.message).toContain("does not appear to be a git repository");
    expect(error.cause).toBeDefined();
  });
});
