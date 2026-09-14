/**
 * The navigation server as something that outlives a terminal: where its
 * lockfile lives, how a CLI invocation finds a running one or starts one
 * detached, and the build function the running server turns PR URLs into
 * pages with.
 *
 * The lockfile under the state dir (`~/.deep-review`, or $DEEP_REVIEW_HOME)
 * names the port a server claims to listen on; the claim is only believed
 * after `/health` answers, so a machine that rebooted or a server that was
 * killed leaves nothing worse than a stale file to overwrite.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { renderSliceExplorerHtml } from "@deep-review/call-graph";
import { fetchPrInfo, releaseCheckouts, removeRepoWorkDir } from "@deep-review/pr";
import { forkBuild } from "./buildFork.js";
import { LEGACY_WORK_DIR, legacyWorkDirOf, lockFile, logFile, prsDir, repoWorkDir, stateDir, workRoot } from "./paths.js";
import type { AddOptions, CheckoutRef, PrFacts, PrKey, PrRef, PrView } from "./registry.js";
import { startNavServer, VERSION, type NavServer } from "./serve.js";
import { fileStore } from "./store.js";

export { logFile, prsDir, stateDir } from "./paths.js";

interface ServerLock {
  pid: number;
  port: number;
  url: string;
  version: string;
  startedAt: number;
}

function readLock(): ServerLock | null {
  try {
    const lock = JSON.parse(readFileSync(lockFile(), "utf8")) as ServerLock;
    return Number.isInteger(lock.port) && Number.isInteger(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

/** The lock's claim, verified: what the server there says about itself, or null. */
async function probe(
  url: string,
  timeoutMs = 1500,
): Promise<{ version: string; hasGithubToken: boolean } | null> {
  try {
    const response = await fetch(new URL("/health", url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      ok?: boolean;
      version?: string;
      hasGithubToken?: boolean;
    };
    if (body.ok !== true) return null;
    return { version: body.version ?? "0.0.0", hasGithubToken: body.hasGithubToken === true };
  } catch {
    return null;
  }
}

/** A verified running server's URL, or null. */
export async function findServer(): Promise<string | null> {
  const lock = readLock();
  if (!lock) return null;
  return (await probe(lock.url)) ? lock.url : null;
}

/**
 * Whether the lock's claimant exists as a process at all. The server runs
 * builds on its own event loop, and a clone of a large repo blocks it for
 * minutes — long enough for `/health` to time out. A dead probe with a live
 * pid means busy, not gone; only both dead means gone.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The running server's claim while it may be too busy to answer: its lock, pid-checked. */
export function serverBusyOrAlive(): { url: string; pid: number } | null {
  const lock = readLock();
  if (!lock || !pidAlive(lock.pid)) return null;
  return { url: lock.url, pid: lock.pid };
}

/**
 * A retired PR gives its checkouts back. Its worktrees go unless another
 * held PR of the same repo is on the same commit; the clone goes when no
 * held PR of the repo remains. A PR built under the old per-PR layout takes
 * its whole directory with it.
 */
function retireCheckouts(removed: CheckoutRef, remaining: CheckoutRef[], log: (m: string) => void): void {
  const legacy = legacyWorkDirOf(removed.headDir);
  if (legacy) {
    rmSync(legacy, { recursive: true, force: true });
    log(`${removed.owner}/${removed.repo}#${removed.number}: removed ${legacy}.`);
    return;
  }
  const root = repoWorkDir(removed);
  const survivors = remaining.filter((pr) => pr.owner === removed.owner && pr.repo === removed.repo);
  if (survivors.length === 0) {
    removeRepoWorkDir(root);
    try {
      // The owner directory too, if this was its last repo.
      rmdirSync(path.dirname(root));
    } catch {
      // Other repos of the owner remain, or it is already gone.
    }
    log(`${removed.owner}/${removed.repo}: no PRs left; removed ${root}.`);
    return;
  }
  const shas = survivors.flatMap((pr) => [pr.baseSha, pr.headSha]).filter((sha): sha is string => Boolean(sha));
  const { removed: gone } = releaseCheckouts(root, { shas });
  if (gone.length > 0) log(`${removed.owner}/${removed.repo}#${removed.number}: released ${gone.length} worktree${gone.length === 1 ? "" : "s"}.`);
}

/**
 * Once, on start: drop every old-layout directory no held PR still reads
 * from. They were orphaned when the layout changed, and nothing else will
 * ever look at them.
 */
function sweepLegacyWorkDirs(held: CheckoutRef[], log: (m: string) => void): void {
  const root = workRoot();
  if (!existsSync(root)) return;
  const inUse = new Set(held.map((pr) => legacyWorkDirOf(pr.headDir)).filter(Boolean));
  let swept = 0;
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    if (!LEGACY_WORK_DIR.test(name) || inUse.has(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    swept++;
  }
  if (swept > 0) log(`removed ${swept} old per-PR work director${swept === 1 ? "y" : "ies"} under ${root}.`);
}

/** The port the server tries first; `$DEEP_REVIEW_PORT` overrides it, `--port` overrides both. */
export const DEFAULT_PORT = 7331;

function preferredPort(): number {
  const env = process.env.DEEP_REVIEW_PORT;
  return env && /^\d+$/.test(env) ? Number(env) : DEFAULT_PORT;
}

export interface RunDaemonOptions {
  port?: number | undefined;
  concurrency?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

/**
 * Run the server in this process and stake the lockfile claim. Refuses to
 * start while a verified server is already up — two servers means two
 * lockfile writers and split PRs. The claim is withdrawn on any exit path
 * that runs code: `/quit`, Ctrl-C, SIGTERM.
 */
export async function runDaemon(options: RunDaemonOptions = {}): Promise<NavServer> {
  const existing = await findServer();
  if (existing) {
    throw new Error(`A server is already running at ${existing} (pr-review stop to stop it).`);
  }
  const startOn = (port: number): Promise<NavServer> =>
    startNavServer({
      // Each build in its own child process: the server stays answerable
      // while a clone or a language service runs for minutes.
      build: forkBuild(),
      // A re-added PR is only trusted while its head has not moved.
      currentHeadSha: async (ref) => (await fetchPrInfo(ref)).headSha,
      persistence: {
        store: fileStore(prsDir(), {
          // The previous single-file layout, converted once on first start.
          legacyFile: path.join(stateDir(), "registry.json"),
          ...(options.onProgress ? { onProblem: options.onProgress } : {}),
        }),
        // Stored builds come back in this version's chrome.
        render: ({ input }) => renderSliceExplorerHtml(input),
      },
      onRemoved: (removed, remaining) => retireCheckouts(removed, remaining, options.onProgress ?? (() => {})),
      port,
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  let server: NavServer;
  if (options.port !== undefined) {
    server = await startOn(options.port);
  } else {
    // The same port every time, when it is free: a browser remembers its
    // theme and tab per origin, and a bookmark to the index should survive
    // a restart. Taken by something else, any free port will do.
    const preferred = preferredPort();
    try {
      server = await startOn(preferred);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      options.onProgress?.(`port ${preferred} is taken; listening on a free one instead.`);
      server = await startOn(0);
    }
  }
  sweepLegacyWorkDirs(server.registry.checkouts(), options.onProgress ?? (() => {}));
  mkdirSync(stateDir(), { recursive: true });
  const lock: ServerLock = {
    pid: process.pid,
    port: server.port,
    url: server.url,
    version: VERSION,
    startedAt: Date.now(),
  };
  // The claim is contested through exclusive create: two first invocations
  // that both found no server will both reach here, and check-then-write
  // would leave the loser running forever with no lock pointing at it.
  // A loser defers to a live claimant and shuts itself down; a dead
  // claimant's file is cleared and the claim retried — but only while the
  // file still holds the claim that failed the probe, so a rival who won
  // the meantime is deferred to on the next pass, not deleted.
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lockFile(), JSON.stringify(lock, null, 2), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 5) {
        await server.close();
        throw error;
      }
      const claimant = readLock();
      if (
        claimant &&
        claimant.pid !== process.pid &&
        ((await probe(claimant.url)) || pidAlive(claimant.pid))
      ) {
        await server.close();
        throw new Error(
          `A server is already running at ${claimant.url} (pr-review stop to stop it).`,
        );
      }
      const now = readLock();
      if (now && claimant && (now.pid !== claimant.pid || now.port !== claimant.port)) {
        continue; // someone else claimed while we probed; judge them next pass
      }
      rmSync(lockFile(), { force: true });
    }
  }

  const releaseLock = (): void => {
    // Only withdraw our own claim; a newer server may have overwritten it.
    if (readLock()?.pid === process.pid) rmSync(lockFile(), { force: true });
  };
  void server.closed.then(releaseLock);
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}

/**
 * Find the running server or start one detached from this terminal — its
 * own session, stdio to the server log — and wait for it to answer. The
 * spawned process is this same CLI with `serve`, so there is exactly one
 * code path a server starts through.
 */
export interface EnsuredServer {
  url: string;
  started: boolean;
  /** Set when the running server's version differs from this CLI's, either way. */
  serverVersion?: string;
  /**
   * Set when this process has GITHUB_TOKEN but the running server does not.
   * The server keeps the env of whichever shell spawned it, so a token
   * exported later never reaches it — private-repo builds then fail with a
   * hint that blames the shell, which is the one place the token *is* set.
   */
  missingGithubToken?: boolean;
}

export async function ensureServer(): Promise<EnsuredServer> {
  const lock = readLock();
  if (lock) {
    const health = await probe(lock.url);
    if (health) {
      return {
        url: lock.url,
        started: false,
        ...(health.version !== VERSION ? { serverVersion: health.version } : {}),
        ...(process.env.GITHUB_TOKEN && !health.hasGithubToken
          ? { missingGithubToken: true }
          : {}),
      };
    }
    // Not answering but the process exists: a build is blocking its event
    // loop. Use it — spawning a rival because the incumbent is busy is how
    // two servers happen.
    if (pidAlive(lock.pid)) return { url: lock.url, started: false };
  }

  mkdirSync(stateDir(), { recursive: true });
  const log = openSync(logFile(), "a");
  // Re-run this same CLI with `serve`, carrying this process's own loader
  // flags: run through tsx the CLI is a .ts file plain node cannot take,
  // and execArgv is exactly the stack that made it runnable here.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();

  // The server writes its lockfile only once it is listening; believe it
  // when /health answers. A model-heavy machine can be slow to boot Node,
  // so give it a real moment before declaring failure.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const url = await findServer();
    if (url) return { url, started: true };
    if (child.exitCode !== null && child.exitCode !== 0) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`The server did not come up; see ${logFile()}.`);
}

/** Ask the running server to add a PR; it builds in the background there. */
export async function addPrToServer(
  serverUrl: string,
  ref: PrRef,
  options: AddOptions,
  facts: PrFacts = {},
): Promise<PrView> {
  const response = await fetch(new URL("/prs", serverUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...ref, options, facts }),
  });
  const body = (await response.json()) as { pr?: PrView; why?: string };
  if (!response.ok || !body.pr) {
    throw new Error(body.why ?? `the server said ${response.status}`);
  }
  return body.pr;
}

/**
 * Tell the server what GitHub now says about a PR it holds — approval most
 * of all. False when the server does not hold it (nothing to update; the
 * watcher will hand it over if it should).
 */
export async function updatePrFacts(serverUrl: string, key: PrKey, facts: PrFacts): Promise<boolean> {
  const response = await fetch(new URL(`/prs/${encodeURIComponent(key)}`, serverUrl), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(facts),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return true;
}

export async function listServerPrs(serverUrl: string): Promise<PrView[]> {
  const response = await fetch(new URL("/prs", serverUrl));
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return ((await response.json()) as { prs: PrView[] }).prs;
}

/**
 * Ask the running server to drop a PR, by its `owner/repo#number` key. True
 * when the server held it; false when it did not, which is not an error —
 * the caller's memory of what the server holds is allowed to be stale.
 */
export async function removePrFromServer(serverUrl: string, key: PrKey): Promise<boolean> {
  const response = await fetch(new URL(`/prs/${encodeURIComponent(key)}`, serverUrl), {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return ((await response.json()) as { removed: boolean }).removed;
}

/**
 * Stop the running server, if any, and wait until it is actually gone —
 * "stopped" that returns while the port and lockfile are still live would
 * make `pr-review stop && pr-review serve` flaky. True when there was one
 * to stop.
 */
export async function stopServer(): Promise<boolean> {
  const lock = readLock();
  if (!lock) return false;
  const url = lock.url;
  if (!(await probe(url)) && !pidAlive(lock.pid)) {
    // Dead claim, dead process; clear it so the next start is clean.
    rmSync(lockFile(), { force: true });
    return false;
  }
  await fetch(new URL("/quit", url), { method: "POST" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await probe(url, 500))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The server at ${url} did not stop; kill pid ${readLock()?.pid ?? "?"} by hand.`);
}
