/**
 * Where everything the server and watcher keep lives: one directory of
 * truth, `~/.deep-review` (or $DEEP_REVIEW_HOME), shared by the CLI, the
 * server and the watcher even though they are separate processes.
 */

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { repoWorkRoot, type PrRef } from "@deep-review/pr";

export function stateDir(): string {
  return process.env.DEEP_REVIEW_HOME ?? path.join(os.homedir(), ".deep-review");
}

/** The running server's claim: pid, port, url. */
export function lockFile(): string {
  return path.join(stateDir(), "server.json");
}

export function logFile(): string {
  return path.join(stateDir(), "server.log");
}

/** One file per PR the server holds, so a restart shows them without rebuilding. */
export function prsDir(): string {
  return path.join(stateDir(), "prs");
}

/** Where clones and worktrees live: under the state dir, which macOS does not purge the way it does tmp. */
export function workRoot(): string {
  return path.join(stateDir(), "work");
}

/**
 * One work dir per repo, shared by every PR of it: a single clone, and a
 * worktree per commit (see prepareCheckouts), so ten PRs cost one clone and
 * two PRs off the same base share a checkout without either swapping the
 * other's out from under its language service.
 */
export function repoWorkDir(ref: Pick<PrRef, "owner" | "repo">): string {
  return repoWorkRoot(workRoot(), ref);
}

/**
 * The client app's build, beside this package in the checkout: from src/ in
 * development and from dist/ when the CLI is built, the same two levels up.
 * Set DEEP_REVIEW_UI=classic to ignore it and get the server's own pages.
 */
export function uiDist(): string | null {
  if (process.env.DEEP_REVIEW_UI === "classic") return null;
  return fileURLToPath(new URL("../../ui/dist/", import.meta.url));
}

/** The layout before per-repo roots: `work/<owner>-<repo>-pr<n>`, one clone each. */
export const LEGACY_WORK_DIR = /^[^/]+-[^/]+-pr\d+$/;

/** The old per-PR directory a head checkout sits in, if it is one. */
export function legacyWorkDirOf(headDir: string | undefined): string | null {
  if (!headDir) return null;
  const dir = path.dirname(headDir);
  return path.dirname(dir) === workRoot() && LEGACY_WORK_DIR.test(path.basename(dir)) ? dir : null;
}

/** One path-safe filename segment; GitHub names are tame, but the path must not care. */
export function safeName(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The slice JSON a fresh run of this PR is kept at. Keyed by the PR's full
 * identity — owner included, or `vercel/swr#100` and a fork's `swr#100`
 * would share a file.
 */
export function cachedSliceFile(ref: PrRef): string {
  return path.join(stateDir(), "slices", `slices-${safeName(ref.owner)}-${safeName(ref.repo)}-pr${ref.number}.json`);
}
