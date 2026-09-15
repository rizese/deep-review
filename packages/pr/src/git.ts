import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { BuildError, ConfigError, DeepReviewError, TransientError } from "./errors.js";
import type { PrInfo } from "./github.js";
import type { PrRef } from "./prUrl.js";

export interface Checkouts {
  /** Working tree at the merge base — the PR's "before". */
  baseDir: string;
  /** Working tree at the PR's head commit. */
  headDir: string;
  /**
   * The commit the PR branched from: `git merge-base baseSha headSha`, not
   * `baseSha` itself. GitHub reports `base.sha` as the current tip of the base
   * branch, so on a branch that has fallen behind, diffing against it pulls in
   * every unrelated commit that landed on the base since. This is the commit
   * GitHub's own "Files changed" compares against.
   */
  mergeBaseSha: string;
  /** `git diff mergeBase head` output. */
  diffText: string;
}

/* ------------------------------------------------------------------ *
 * Running git
 * ------------------------------------------------------------------ */

/**
 * Every git invocation in this module goes through here — nothing else calls
 * a child process. The calls are synchronous today because the callers are,
 * but keeping them behind one function means moving the work to a worker
 * process (or to `execFile`'s promise form) is a change to this body alone.
 */
function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        // Never sit at an invisible credential prompt: fail, and say so.
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } catch (error) {
    throw classifyGitFailure(args, cwd, error);
  }
}

interface GitAttempt {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: unknown;
}

/** `runGit` for the places that want to look at a failure rather than throw it. */
function tryGit(args: string[], cwd: string): GitAttempt {
  try {
    return { ok: true, stdout: runGit(args, cwd), stderr: "", error: null };
  } catch (error) {
    return { ok: false, stdout: "", stderr: stderrOf(error), error };
  }
}

/** The git-side text of a failure: its stderr if it has one, else its own message. */
function stderrOf(error: unknown): string {
  if (error instanceof DeepReviewError) return error.message;
  const e = error as { stderr?: unknown; message?: unknown };
  const raw = e?.stderr;
  const text =
    typeof raw === "string" ? raw : raw instanceof Buffer ? raw.toString("utf8") : "";
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  return typeof e?.message === "string" ? e.message : String(error);
}

/**
 * Git failures that mean this machine is not set up to reach the repo: no
 * credentials, the wrong ones, or a URL nobody there will serve us.
 */
const AUTH_FAILURE =
  /could not read Username|could not read Password|Authentication failed|Permission denied|Repository not found|Invalid username or password|terminal prompts disabled|returned error: 4\d\d/i;

/** Git failures that mean the network hiccuped; the same command may work next time. */
const NETWORK_FAILURE =
  /Could not resolve host|Connection (?:reset|refused|timed out)|early EOF|RPC failed|unable to access|The remote end hung up|Operation timed out|Failed to connect/i;

/**
 * Git failures that mean the remote is not a repository we can read. Checked
 * *after* the network patterns on purpose: git prints "Could not read from
 * remote repository" as the summary line of an ssh timeout too, and a timeout
 * is transient even when its epilogue reads like a permissions problem.
 */
const UNREACHABLE_REMOTE =
  /does not appear to be a git repository|Could not read from remote repository|remote repository does not exist/i;

/**
 * A git failure as one of our typed errors, with the stderr kept verbatim in
 * the message and the original error as `cause`. Nothing git said is dropped.
 */
function classifyGitFailure(args: string[], cwd: string, error: unknown): DeepReviewError {
  if (error instanceof DeepReviewError) return error;
  const stderr = stderrOf(error);
  const message = `git ${args.join(" ")} failed in ${cwd}: ${stderr}`;
  if (AUTH_FAILURE.test(stderr)) return new ConfigError(message, { cause: error });
  if (NETWORK_FAILURE.test(stderr)) return new TransientError(message, { cause: error });
  if (UNREACHABLE_REMOTE.test(stderr)) return new ConfigError(message, { cause: error });
  return new BuildError(message, { cause: error });
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

/**
 * The per-repo root every PR of one repository shares:
 * `<workRoot>/<owner>/<repo>`. Inside it live `repo/` (one blob-less clone)
 * and `wt/<sha>/` (one worktree per commit anyone asked for). Ten PRs of one
 * repository cost one clone, not ten.
 */
export function repoWorkRoot(workRoot: string, ref: Pick<PrRef, "owner" | "repo">): string {
  return path.join(workRoot, safeName(ref.owner), safeName(ref.repo));
}

/** One path-safe filename segment; GitHub names are tame, but the path must not care. */
function safeName(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

/** Where repos land when the caller names no directory. */
function defaultWorkRoot(): string {
  return path.join(os.tmpdir(), "deep-review", "work");
}

function repoDirOf(repoRoot: string): string {
  return path.join(repoRoot, "repo");
}

function worktreesDirOf(repoRoot: string): string {
  return path.join(repoRoot, "wt");
}

function worktreeDirOf(repoRoot: string, sha: string): string {
  return path.join(worktreesDirOf(repoRoot), sha);
}

/* ------------------------------------------------------------------ *
 * Locking
 * ------------------------------------------------------------------ */

/** How long to wait for another process's lock before giving up. */
const LOCK_TIMEOUT_MS = 60_000;
/** A lock older than this is assumed to belong to a process that died holding it. */
const LOCK_STALE_MS = 10 * 60_000;

/** Block this thread without spinning; the work here is synchronous by design. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Hold `lockFile` for the duration of `body`. Two builds may prepare the same
 * repository at the same time — the daemon runs two PRs concurrently — and
 * `git clone` into a half-written directory, or two `worktree add`s racing on
 * one path, are both worth serialising. `wx` makes creation the atomic part.
 */
function withLock<T>(lockFile: string, body: () => T): T {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let waited = 0;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockFile, "wx");
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") {
        throw new BuildError(`could not take the lock at ${lockFile}`, { cause: error });
      }
      if (lockIsStale(lockFile)) {
        try {
          unlinkSync(lockFile);
        } catch {
          // Someone else cleared it first; loop and try to create it again.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new TransientError(
          `timed out after ${LOCK_TIMEOUT_MS}ms waiting for the lock at ${lockFile}; another build may still be preparing this repository`,
          { cause: error },
        );
      }
      waited = Math.min(waited === 0 ? 25 : waited * 2, 500);
      sleepSync(waited);
    }
  }
  try {
    return body();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockFile);
    } catch {
      // Already gone (a stale-sweep, or a cleanup): nothing to release.
    }
  }
}

function lockIsStale(lockFile: string): boolean {
  try {
    return Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Clone and worktrees
 * ------------------------------------------------------------------ */

/** True once `repoDir` is a git directory we can talk to, rather than merely present. */
function isRepo(repoDir: string): boolean {
  if (!existsSync(path.join(repoDir, ".git"))) return false;
  return tryGit(["rev-parse", "--git-dir"], repoDir).ok;
}

/**
 * The one clone for this repository, made if it is not there yet. Blob-less
 * and unchecked-out: the objects worktrees need are fetched on demand.
 */
function ensureClone(repoRoot: string, cloneUrl: string): string {
  const repoDir = repoDirOf(repoRoot);
  if (isRepo(repoDir)) return repoDir;
  mkdirSync(repoRoot, { recursive: true });
  return withLock(`${repoDir}.lock`, () => {
    // Someone may have finished the clone while we waited for the lock.
    if (isRepo(repoDir)) return repoDir;
    // A directory that is present but not a repository is a half-written
    // clone from a process that died; there is nothing in it to save.
    rmSync(repoDir, { recursive: true, force: true });
    runGit(["clone", "--filter=blob:none", "--no-checkout", cloneUrl, repoDir], repoRoot);
    return repoDir;
  });
}

/** True when `sha` is already a commit in this clone — no fetch needed. */
function hasCommit(repoDir: string, sha: string): boolean {
  return tryGit(["cat-file", "-e", `${sha}^{commit}`], repoDir).ok;
}

/**
 * Make sure every SHA the PR needs is in the clone, fetching only what is
 * missing. Bare-SHA fetches are refused by some servers, so the fallback asks
 * for the two refs that between them are guaranteed to contain both commits.
 */
function ensureCommits(repoDir: string, info: PrInfo, shas: string[]): void {
  const missing = [...new Set(shas)].filter((sha) => !hasCommit(repoDir, sha));
  if (missing.length === 0) return;
  const direct = tryGit(["fetch", "--force", "origin", ...missing], repoDir);
  if (direct.ok && missing.every((sha) => hasCommit(repoDir, sha))) return;
  runGit(
    ["fetch", "--force", "origin", info.baseRef, `refs/pull/${info.number}/head`],
    repoDir,
  );
  const stillMissing = missing.filter((sha) => !hasCommit(repoDir, sha));
  if (stillMissing.length > 0) {
    throw new BuildError(
      `fetched ${info.baseRef} and refs/pull/${info.number}/head from origin but ${stillMissing.join(", ")} is still not in ${repoDir}${direct.stderr ? `; the direct fetch said: ${direct.stderr}` : ""}`,
      { cause: direct.error },
    );
  }
}

/** The commit a worktree is on, or null when the directory is not a usable worktree. */
function worktreeHead(dir: string): string | null {
  const head = tryGit(["rev-parse", "HEAD"], dir);
  return head.ok ? head.stdout.trim() : null;
}

/** Tear a worktree down by whatever means works, and forget it in the parent repo. */
function discardWorktree(repoDir: string, dir: string): void {
  tryGit(["worktree", "remove", "--force", dir], repoDir);
  rmSync(dir, { recursive: true, force: true });
  tryGit(["worktree", "prune"], repoDir);
}

/**
 * The worktree for one commit, shared by every PR that wants that commit.
 * Keyed by SHA, so nothing is ever swapped out from under a language service
 * the way fixed `base`/`head` paths were. A directory that exists but does not
 * answer `rev-parse`, or answers with the wrong commit, is rebuilt.
 */
function ensureWorktree(repoDir: string, repoRoot: string, sha: string): string {
  const dir = worktreeDirOf(repoRoot, sha);
  if (worktreeHead(dir) === sha) return dir;
  return withLock(`${repoDir}.lock`, () => {
    if (worktreeHead(dir) === sha) return dir;
    if (existsSync(dir)) discardWorktree(repoDir, dir);
    mkdirSync(worktreesDirOf(repoRoot), { recursive: true });
    const added = tryGit(["worktree", "add", "--detach", dir, sha], repoDir);
    if (added.ok) return dir;
    // A worktree git still remembers at this path, from a directory that was
    // deleted out from under it: forget it and try once more.
    if (/already exists|already registered|missing but already registered/i.test(added.stderr)) {
      discardWorktree(repoDir, dir);
      runGit(["worktree", "add", "--detach", dir, sha], repoDir);
      return dir;
    }
    if (worktreeHead(dir) === sha) return dir; // Lost a race; the winner's tree is fine.
    throw classifyGitFailure(["worktree", "add", "--detach", dir, sha], repoDir, added.error);
  });
}

/* ------------------------------------------------------------------ *
 * The public surface
 * ------------------------------------------------------------------ */

/**
 * Materialize the merge-base and head worktrees for a PR, plus the diff
 * between them, reusing one clone per repository.
 *
 * `workDir` is the **per-repo** root — `<workRoot>/<owner>/<repo>`, as
 * `repoWorkRoot` builds it — not a per-PR directory, which is what it used to
 * mean. Every PR of a repository should be given the same one: they share the
 * clone under `repo/`, and two PRs off the same base share its worktree under
 * `wt/<sha>/`. Passing a per-PR directory still works, it just buys a clone
 * per PR again. Omitted, it defaults to a per-repo directory under the OS
 * temp dir.
 *
 * Worktrees are never reused for a different commit, so a checkout a caller
 * still holds cannot change underfoot; `releaseCheckouts` is what reclaims
 * them once nobody needs them.
 */
export function prepareCheckouts(info: PrInfo, workDir?: string): Checkouts {
  const repoRoot = workDir ?? repoWorkRoot(defaultWorkRoot(), info);
  mkdirSync(repoRoot, { recursive: true });
  const repoDir = ensureClone(repoRoot, info.cloneUrl);

  ensureCommits(repoDir, info, [info.baseSha, info.headSha]);
  const mergeBaseSha = runGit(["merge-base", info.baseSha, info.headSha], repoDir).trim();

  const baseDir = ensureWorktree(repoDir, repoRoot, mergeBaseSha);
  const headDir = ensureWorktree(repoDir, repoRoot, info.headSha);
  const diffText = runGit(["diff", "--unified=3", mergeBaseSha, info.headSha], repoDir);

  return { baseDir, headDir, mergeBaseSha, diffText };
}

/** The worktrees present under a repo root, by the commit each is checked out at. */
function worktreeShas(repoRoot: string): string[] {
  try {
    return readdirSync(worktreesDirOf(repoRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Drop every worktree under `repoRoot` whose commit is not in `keep.shas`,
 * and prune what git still remembers. The clone itself stays: a repository
 * with one PR left should not pay to clone itself again for the next one.
 * Returns the worktree directories removed.
 */
export function releaseCheckouts(
  repoRoot: string,
  keep: { shas: string[] },
): { removed: string[] } {
  const repoDir = repoDirOf(repoRoot);
  const wanted = new Set(keep.shas.map((sha) => sha.trim().toLowerCase()));
  const removed: string[] = [];
  for (const sha of worktreeShas(repoRoot)) {
    if (wanted.has(sha.toLowerCase())) continue;
    const dir = worktreeDirOf(repoRoot, sha);
    if (isRepo(repoDir)) discardWorktree(repoDir, dir);
    else rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  if (removed.length > 0 && isRepo(repoDir)) tryGit(["worktree", "prune"], repoDir);
  return { removed };
}

/**
 * Delete a repository's work directory outright — clone, worktrees and all.
 * For when the last PR of that repository is retired and the next one, if it
 * ever comes, can afford the clone.
 */
export function removeRepoWorkDir(repoRoot: string): void {
  rmSync(repoRoot, { recursive: true, force: true });
}
