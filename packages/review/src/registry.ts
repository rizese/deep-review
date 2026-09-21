/**
 * The set of PRs one navigation server holds, and the lifecycle of each.
 *
 * A PR arrives as a URL and nothing else. Slicing it and walking its call
 * graphs is slow — a paid model call, then a language service over a whole
 * checkout — so a PR is added at once and built in the background, a few at
 * a time; the page for it says "building" until it is ready. Once built, its
 * language services are started only when a reader first clicks a symbol,
 * and let go again when the page goes away or the entry sits idle, because
 * a session is fully derivable from what was built and cheap to recreate.
 *
 * What was built is kept on disk too. A server lives for weeks and is
 * restarted for the most ordinary reasons — a new version, a reboot — and
 * without a memory every restart emptied the index and cost a slicing run
 * per PR to refill it. Ready and failed PRs are written to a `PrStore` (one
 * file per PR; see store.ts) as they change, and read back when the
 * registry is made, so a restart resumes with the same pages and no builds.
 * What is stored is a build's input; the page is the client app's to render
 * from it, so a new version of the app shows on old PRs too.
 */

import { existsSync } from "node:fs";
import {
  explorerSize,
  NavSession,
  panelRendererFor,
  type SizeBreakdown,
  type SliceExplorerInput,
} from "@deep-review/call-graph";
import { failureKindOf, prUrl, type FailureKind, type PrRef, type PrRole } from "@deep-review/pr";
import type { PrStore, StoredPr } from "./store.js";

export type { PrRef, PrRole } from "@deep-review/pr";

/** A PR's identity across everything here: `owner/repo#number`. */
export type PrKey = string;

export function prKey(ref: PrRef): PrKey {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** Where a PR's page and its navigation endpoints are mounted, with a trailing slash. */
export function prMountPath(ref: PrRef): string {
  return `/pr/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.number}/`;
}

/**
 * The parse half of `prMountPath`: which PR a request path names, and the
 * rest of the path under its prefix. `/pr/vercel/swr/2950/panel` → that PR,
 * `/panel`. Null for paths that are not under a PR prefix — including a
 * malformed percent-escape, which is a bad address, not a server fault.
 */
export interface PrRoute {
  ref: PrRef;
  key: PrKey;
  rest: string;
  /** The request pointed at the PR itself without a trailing slash. */
  needsSlash: boolean;
  mount: string;
}

export function parsePrPath(pathname: string): PrRoute | null {
  const parts = pathname.split("/").filter((p) => p !== "");
  if (parts.length < 4 || parts[0] !== "pr") return null;
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(parts[1]!);
    repo = decodeURIComponent(parts[2]!);
  } catch {
    return null;
  }
  const number = Number(parts[3]);
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return null;
  const ref = { owner, repo, number };
  return {
    ref,
    key: prKey(ref),
    rest: `/${parts.slice(4).join("/")}`,
    needsSlash: parts.length === 4 && !pathname.endsWith("/"),
    mount: prMountPath(ref),
  };
}

/**
 * How far along a PR is. `queued` and `building` both mean the page is not
 * there yet; `failed` is terminal until the PR is added again, and keeps the
 * reason so the index can show it rather than a blank row.
 */
export type PrState = "queued" | "building" | "ready" | "failed";

/**
 * What is known about a PR from GitHub rather than from its build: which
 * list it belongs on and whether it has been approved. Set when a PR is
 * added and refreshed by the watcher on every poll, since an approval can
 * land long after the page was built. Every field is optional so a caller
 * can say only what it knows; absent means unchanged.
 */
export interface PrFacts {
  /** Waiting on your review (the default), or one you opened. */
  role?: PrRole | undefined;
  approved?: boolean | undefined;
  /** Who approved, when known. */
  approvers?: string[] | undefined;
  author?: string | undefined;
  draft?: boolean | undefined;
  /** The PR's head commit as GitHub reports it now; a change un-parks a failed build. */
  headSha?: string | undefined;
}

/**
 * How a failed PR stands with respect to being tried again. The kind decides
 * the policy (see RetryPolicy); attempts count failures since the last
 * success or reset; `nextRetryAt` is set while a retry is scheduled and
 * `parked` when nothing will happen until the PR's head moves or someone
 * asks — which is also what a restart does for transient and config
 * failures, since a restart is when the environment changes.
 */
export interface PrFailure {
  kind: FailureKind;
  attempts: number;
  /** When the first of the current run of failures happened. */
  firstFailedAt: number;
  nextRetryAt?: number | undefined;
  parked: boolean;
  /** The head commit the PR was at when it failed, when known. */
  headSha?: string | undefined;
}

/**
 * When to try a failed build again. Transient failures back off along the
 * schedule and give up after `transientMaxMs` from the first failure. Build
 * failures — our own pipeline, or model output that would not validate —
 * get `buildRetries` more goes, since the model is not deterministic, then
 * park until the head moves. Config and input failures park at once:
 * nothing about a retry would differ.
 */
export interface RetryPolicy {
  transientDelaysMs: number[];
  transientMaxMs: number;
  buildRetries: number;
  buildDelayMs: number;
}

const DEFAULT_RETRY: RetryPolicy = {
  transientDelaysMs: [60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000],
  transientMaxMs: 24 * 3_600_000,
  buildRetries: 1,
  buildDelayMs: 60_000,
};

/**
 * What changed, for whoever is listening: a PR's view after any change to
 * it — state, a log line, its facts — or a PR gone. `/events` streams
 * these so a page learns of a build finishing the moment it does rather
 * than on its next poll.
 */
export type RegistryEvent = { type: "pr"; pr: PrView } | { type: "removed"; key: PrKey };

/** What a PR looks like from outside: the index page and `/prs` both read this. */
export interface PrView extends PrRef {
  prUrl: string;
  key: PrKey;
  state: PrState;
  /** Which tab of the index it belongs on. */
  role: PrRole;
  approved: boolean;
  approvers: string[];
  author?: string | undefined;
  draft?: boolean | undefined;
  /** Mount path, so a caller can build the page URL without knowing the scheme. */
  path: string;
  title?: string | undefined;
  slices?: number | undefined;
  /** Slices that got a walkable call graph. */
  graphs?: number | undefined;
  /** The PR's +/− lines, split core / tests / boilerplate when the slicer classified them. */
  size?: SizeBreakdown | undefined;
  /** Why the build failed, when it did. */
  error?: string | undefined;
  /** How the failure stands: its kind, and whether and when it will be retried. */
  failure?: PrFailure | undefined;
  addedAt: number;
  readyAt?: number | undefined;
  /** The head commit the build was made from, for staleness checks. */
  headSha?: string | undefined;
  /** The build's progress lines, newest last — what the index shows while building. */
  log: string[];
  /** Whether language services are up for this PR right now. */
  live: boolean;
}

/** What a build produced: enough to render the page and answer about symbols. */
export interface BuiltPr {
  input: SliceExplorerInput;
  /** The PR's head checkout, which the language services read. */
  headDir: string;
  /** The head commit this build was made from; a moved head means a stale build. */
  headSha?: string | undefined;
  /** The merge-base commit the base checkout is at; with headSha, the two worktrees this build keeps alive. */
  baseSha?: string | undefined;
}

/** What a PR's build holds on disk: its checkouts, by directory and by commit. */
export interface CheckoutRef extends PrRef {
  headDir?: string | undefined;
  headSha?: string | undefined;
  baseSha?: string | undefined;
}

/** Per-PR knobs, carried from the request that added it. */
export interface AddOptions {
  /** Reuse a saved slice JSON instead of paying for a fresh slicing run. */
  slicesFile?: string | undefined;
  model?: string | undefined;
  maxGraphs?: number | undefined;
  debugMarks?: boolean | undefined;
}

/**
 * Turns a PR into a built page. Injected rather than imported so the
 * registry's lifecycle can be tested without a model call or a checkout.
 */
export type BuildPr = (
  request: { prUrl: string; navBase: string; options: AddOptions },
  log: (message: string) => void,
) => Promise<BuiltPr>;

export interface RegistryOptions {
  build: BuildPr;
  /** How many PRs may build at once. Slicing and graph analysis are both heavy. */
  concurrency?: number | undefined;
  /**
   * How long after a page says it is gone the language services are let go.
   * A reload says goodbye before the new page says hello, so this is the
   * window in which the new page can cancel the goodbye.
   */
  sessionGraceMs?: number | undefined;
  /** Let a session go after this long with no question asked of it. */
  sessionIdleMs?: number | undefined;
  /** Progress lines kept per PR; the oldest are dropped past this. */
  logLimit?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
  /**
   * Where PRs are remembered between runs: the store keeps a build's input,
   * which is all the client app needs to render the page afresh. Absent, the
   * registry forgets everything on exit.
   */
  persistence?: { store: PrStore } | undefined;
  /**
   * Called after a PR is dropped, with what it held on disk and what every
   * PR still here holds, so its checkouts can be released without taking a
   * worktree another PR shares. The registry itself touches no checkout.
   */
  onRemoved?: ((removed: CheckoutRef, remaining: CheckoutRef[]) => void) | undefined;
  /** When failed builds are tried again; see `RetryPolicy`. */
  retry?: Partial<RetryPolicy> | undefined;
}

interface Entry extends PrRef {
  prUrl: string;
  key: PrKey;
  state: PrState;
  options: AddOptions;
  facts: PrFacts;
  addedAt: number;
  readyAt?: number;
  error?: string;
  failedAt?: number;
  failure?: PrFailure;
  /** Pending retry of a failed build. */
  retryTimer?: NodeJS.Timeout;
  log: string[];
  built?: BuiltPr;
  session?: NavSession;
  /** When a question was last asked of this PR's session. */
  lastUsed: number;
  /** Pending "the page is gone, let the session go" timer. */
  release?: NodeJS.Timeout;
}

/** "4m", "90s", "2h": how long until a retry, for a log line or an index row. */
export function humanDelay(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/** Why a failed PR is left alone, by the kind of failure. */
export function parkedNote(kind: FailureKind): string {
  switch (kind) {
    case "config":
      return "not retried: fix the setup, then retry";
    case "input":
      return "not retried: nothing will change until the PR does";
    case "transient":
      return "gave up retrying; retry by hand, or it retries when the PR changes";
    default:
      return "parked until the PR changes; retry by hand to try again now";
  }
}

function checkoutOf(entry: Entry): CheckoutRef {
  return {
    owner: entry.owner,
    repo: entry.repo,
    number: entry.number,
    ...(entry.built?.headDir ? { headDir: entry.built.headDir } : {}),
    ...(entry.built?.headSha ? { headSha: entry.built.headSha } : {}),
    ...(entry.built?.baseSha ? { baseSha: entry.built.baseSha } : {}),
  };
}

/** The facts a caller actually stated: an undefined field means "no news", not "unset". */
function defined(facts: PrFacts): PrFacts {
  const out: PrFacts = {};
  for (const [k, v] of Object.entries(facts)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

const DEFAULTS = {
  concurrency: 2,
  sessionGraceMs: 3000,
  sessionIdleMs: 15 * 60 * 1000,
  logLimit: 200,
};

export class PrRegistry {
  private readonly entries = new Map<PrKey, Entry>();
  private readonly build: BuildPr;
  private readonly concurrency: number;
  private readonly sessionGraceMs: number;
  private readonly sessionIdleMs: number;
  private readonly logLimit: number;
  private readonly log: (message: string) => void;
  private readonly persistence: { store: PrStore } | null;
  private readonly onRemoved: ((removed: CheckoutRef, remaining: CheckoutRef[]) => void) | null;
  private readonly retry: RetryPolicy;
  private readonly listeners = new Set<(event: RegistryEvent) => void>();
  /** Keys waiting for a build slot, in the order they were added. */
  private readonly queue: PrKey[] = [];
  private building = 0;
  private sweep: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(options: RegistryOptions) {
    this.build = options.build;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULTS.concurrency);
    this.sessionGraceMs = options.sessionGraceMs ?? DEFAULTS.sessionGraceMs;
    this.sessionIdleMs = options.sessionIdleMs ?? DEFAULTS.sessionIdleMs;
    this.logLimit = options.logLimit ?? DEFAULTS.logLimit;
    this.log = options.onProgress ?? (() => {});
    this.persistence = options.persistence ?? null;
    this.onRemoved = options.onRemoved ?? null;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    if (this.persistence) this.restore();
    // An idle session is worth reclaiming but not worth watching closely;
    // a sweep at a fraction of the idle window is close enough.
    if (this.sessionIdleMs > 0) {
      this.sweep = setInterval(
        () => this.releaseIdle(),
        Math.max(1000, Math.floor(this.sessionIdleMs / 4)),
      );
      this.sweep.unref();
    }
  }

  /**
   * Add a PR, or return the one already here. Adding a PR that failed
   * retries it; adding one that is queued, building or ready is a no-op, so
   * a reader who runs the same command twice gets the same page rather than
   * a second slicing run. The facts, if any, are taken either way: they are
   * about the PR, not about the build.
   */
  add(ref: PrRef, options: AddOptions = {}, facts: PrFacts = {}): PrView {
    const key = prKey(ref);
    const existing = this.entries.get(key);
    if (existing && existing.state !== "failed") {
      this.applyFacts(existing, facts);
      return this.view(existing);
    }

    const entry: Entry = {
      ...ref,
      prUrl: prUrl(ref),
      key,
      state: "queued",
      options,
      facts: { ...existing?.facts, ...defined(facts) },
      addedAt: Date.now(),
      log: [],
      lastUsed: Date.now(),
    };
    this.entries.set(key, entry);
    this.emit(entry);
    this.queue.push(key);
    this.pump();
    return this.view(entry);
  }

  /** Hear of every change to every PR here; returns the way to stop listening. */
  subscribe(listener: (event: RegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(entry: Entry): void {
    if (this.listeners.size === 0) return;
    const event: RegistryEvent = { type: "pr", pr: this.view(entry) };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log(`a listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** A ready PR's page input, for a client that renders the page itself; null until built. */
  input(key: PrKey): SliceExplorerInput | null {
    return this.entries.get(key)?.built?.input ?? null;
  }

  get(key: PrKey): PrView | null {
    const entry = this.entries.get(key);
    return entry ? this.view(entry) : null;
  }

  /**
   * Bring what GitHub says about a held PR up to date — approval most of
   * all, which the watcher learns on every poll. Null for a PR not here.
   * Nothing is rebuilt: the facts sit beside the build, not inside it.
   */
  setFacts(key: PrKey, facts: PrFacts): PrView | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.applyFacts(entry, facts);
    return this.view(entry);
  }

  private applyFacts(entry: Entry, facts: PrFacts): void {
    const next = { ...entry.facts, ...defined(facts) };
    const changed = JSON.stringify(next) !== JSON.stringify(entry.facts);
    if (!changed) return;
    if (facts.approved !== undefined && facts.approved !== entry.facts.approved) {
      const by = facts.approvers?.length ? ` by ${facts.approvers.join(", ")}` : "";
      this.log(`${entry.key}: ${facts.approved ? `approved${by}` : "no longer approved"}.`);
    }
    entry.facts = next;
    // Facts are stored with the build, so a restart keeps a PR on the right
    // tab rather than defaulting it back to "review".
    this.persist(entry);
    this.emit(entry);
    // A failed PR whose head has moved is a different PR: whatever went wrong
    // may be fixed, so it is tried again now, with a clean slate.
    if (entry.state === "failed" && facts.headSha && entry.failure && entry.failure.headSha !== facts.headSha) {
      delete entry.failure;
      this.requeue(entry, `head moved to ${facts.headSha.slice(0, 8)}; retrying`);
    }
  }

  /** Try a failed PR again, now: back in the queue, its failure kept for the backoff to count. */
  private requeue(entry: Entry, why: string): void {
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      delete entry.retryTimer;
    }
    entry.state = "queued";
    delete entry.error;
    if (entry.failure) entry.failure = { ...entry.failure, nextRetryAt: undefined, parked: false };
    entry.log.push(why);
    this.log(`${entry.key}: ${why}.`);
    this.emit(entry);
    this.queue.push(entry.key);
    this.pump();
  }

  /**
   * How long until the next try, or null to park. Attempts includes the one
   * that just failed.
   */
  private retryDelay(failure: PrFailure): number | null {
    switch (failure.kind) {
      case "transient": {
        if (Date.now() - failure.firstFailedAt > this.retry.transientMaxMs) return null;
        const delays = this.retry.transientDelaysMs;
        return delays[Math.min(failure.attempts, delays.length) - 1] ?? null;
      }
      case "build":
        return failure.attempts <= this.retry.buildRetries ? this.retry.buildDelayMs : null;
      default:
        return null;
    }
  }

  private scheduleRetry(entry: Entry, delayMs: number): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => {
      delete entry.retryTimer;
      if (this.disposed || this.entries.get(entry.key) !== entry || entry.state !== "failed") return;
      this.requeue(entry, `retrying (attempt ${(entry.failure?.attempts ?? 0) + 1})`);
    }, delayMs);
    entry.retryTimer.unref();
  }

  list(): PrView[] {
    return [...this.entries.values()]
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((e) => this.view(e));
  }

  /** How many PRs are held, without building a view of each. */
  count(): number {
    return this.entries.size;
  }

  /** Every held PR's checkouts, for whoever keeps the work directory tidy. */
  checkouts(): CheckoutRef[] {
    return [...this.entries.values()].map(checkoutOf);
  }

  /**
   * This PR's language services, started on the first question asked of it.
   * Null when the PR is not built yet — there is nothing to be warm over.
   */
  sessionFor(key: PrKey): NavSession | null {
    const entry = this.entries.get(key);
    if (!entry?.built) return null;
    entry.lastUsed = Date.now();
    if (entry.release) {
      clearTimeout(entry.release);
      delete entry.release;
    }
    if (!entry.session) {
      // The checkout is only ever read from here, so this is where its
      // absence — a cleaned work dir, a state dir moved between runs — is
      // found. Fail this question, not the page, and not the server.
      if (!existsSync(entry.built.headDir)) {
        throw new Error(
          `the head checkout for ${key} is gone (${entry.built.headDir}); remove and re-add the PR to rebuild it`,
        );
      }
      this.log(`${key}: starting language services.`);
      entry.session = new NavSession(entry.built.headDir, entry.built.input, {
        renderPanel: panelRendererFor(entry.built.input),
      });
      entry.session.warm();
    }
    return entry.session;
  }

  /** The page for this PR loaded: it is here, so nothing pending applies. */
  pageAlive(key: PrKey): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.lastUsed = Date.now();
    if (entry.release) {
      clearTimeout(entry.release);
      delete entry.release;
    }
  }

  /**
   * The page for this PR went away. Its language services are let go after
   * the grace window — the server itself stays up for every other PR.
   */
  pageGone(key: PrKey): void {
    const entry = this.entries.get(key);
    if (!entry || !entry.session) return;
    if (entry.release) clearTimeout(entry.release);
    entry.release = setTimeout(() => {
      delete entry.release;
      this.releaseSession(entry, "page closed");
    }, this.sessionGraceMs);
  }

  /** Drop a PR entirely: its session, its build, its place in the list. */
  remove(key: PrKey): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.release) clearTimeout(entry.release);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    this.releaseSession(entry, "removed");
    const queued = this.queue.indexOf(key);
    if (queued !== -1) this.queue.splice(queued, 1);
    this.entries.delete(key);
    // Forgotten on disk now, not at the next build: the watcher removes a
    // PR once it is merged or closed, and a record that still held it would
    // put it back on the index at the next restart.
    this.persistence?.store.remove(entry);
    for (const listener of this.listeners) {
      try {
        listener({ type: "removed", key });
      } catch {
        // A listener's trouble is its own.
      }
    }
    if (this.onRemoved) {
      try {
        this.onRemoved(checkoutOf(entry), this.checkouts());
      } catch (error) {
        this.log(`${key}: cleanup failed — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const entry of this.entries.values()) {
      if (entry.release) clearTimeout(entry.release);
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      this.releaseSession(entry, "shutting down");
    }
  }

  /** Resolves once nothing is queued or building. Tests and `--wait` use it. */
  async settled(): Promise<void> {
    while (this.building > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private releaseSession(entry: Entry, why: string): void {
    if (!entry.session) return;
    entry.session.dispose();
    delete entry.session;
    this.log(`${entry.key}: language services let go (${why}).`);
  }

  private releaseIdle(): void {
    const cutoff = Date.now() - this.sessionIdleMs;
    for (const entry of this.entries.values()) {
      if (entry.session && entry.lastUsed < cutoff) {
        this.releaseSession(entry, "idle");
      }
    }
  }

  /** Start as many queued builds as the concurrency limit allows. */
  private pump(): void {
    while (!this.disposed && this.building < this.concurrency && this.queue.length > 0) {
      const key = this.queue.shift()!;
      const entry = this.entries.get(key);
      // Removed while it waited for a slot.
      if (!entry || entry.state !== "queued") continue;
      this.building++;
      void this.run(entry).finally(() => {
        this.building--;
        this.pump();
      });
    }
  }

  private async run(entry: Entry): Promise<void> {
    entry.state = "building";
    this.emit(entry);
    const note = (message: string): void => {
      entry.log.push(message);
      if (entry.log.length > this.logLimit) entry.log.shift();
      this.log(`${entry.key}: ${message}`);
      this.emit(entry);
    };
    try {
      const built = await this.build(
        {
          prUrl: entry.prUrl,
          navBase: prMountPath(entry),
          options: entry.options,
        },
        note,
      );
      // Removed while it built: throw the work away rather than resurrect it.
      if (!this.entries.has(entry.key)) return;
      entry.built = built;
      entry.state = "ready";
      entry.readyAt = Date.now();
      delete entry.error;
      delete entry.failure;
      note(
        `ready — ${built.input.slices.length} slices, ${built.input.slices.filter((s) => s.graph).length} with a walkable call graph.`,
      );
    } catch (error) {
      if (!this.entries.has(entry.key)) return;
      entry.state = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      entry.failedAt = Date.now();
      const kind = failureKindOf(error);
      const prior = entry.failure;
      const failure: PrFailure = {
        kind,
        attempts: (prior?.attempts ?? 0) + 1,
        firstFailedAt: prior?.firstFailedAt ?? entry.failedAt,
        parked: false,
        headSha: entry.facts.headSha,
      };
      const delay = this.retryDelay(failure);
      if (delay === null) failure.parked = true;
      else failure.nextRetryAt = Date.now() + delay;
      entry.failure = failure;
      note(`failed (${kind}) — ${entry.error}`);
      if (delay === null) note(parkedNote(kind));
      else {
        note(`retrying in ${humanDelay(delay)} (attempt ${failure.attempts} of this run)`);
        this.scheduleRetry(entry, delay);
      }
    }
    // Both branches said their last word through note(), which emitted.
    this.persist(entry);
  }

  /**
   * Take the stored PRs as this run's, straight into the table: no queue, no
   * build. A ready PR comes back ready, with the input the client app renders
   * it from. A failed PR comes back failed, with its reason, so it can be
   * retried rather than forgotten. Checkouts are not checked here — a page
   * needs none, and the first click that does finds out (sessionFor).
   */
  private restore(): void {
    if (!this.persistence) return;
    let restored = 0;
    for (const stored of this.persistence.store.load()) {
      const key = prKey(stored);
      const base = {
        owner: stored.owner,
        repo: stored.repo,
        number: stored.number,
        prUrl: prUrl(stored),
        key,
        options: stored.options,
        facts: stored.facts,
        addedAt: stored.addedAt,
        lastUsed: Date.now(),
      };
      if (stored.state === "ready" && stored.built) {
        this.entries.set(key, {
          ...base,
          state: "ready",
          readyAt: stored.readyAt ?? stored.addedAt,
          log: ["restored — built in a previous run."],
          built: { ...stored.built },
        });
      } else {
        const entry: Entry = {
          ...base,
          state: "failed",
          error: stored.error ?? "failed in a previous run",
          ...(stored.failedAt !== undefined ? { failedAt: stored.failedAt } : {}),
          log: [`restored — failed in a previous run: ${stored.error ?? "unknown reason"}`],
        };
        this.entries.set(key, entry);
        const kind = stored.failure?.kind;
        if (kind === "transient" || kind === "config") {
          // A restart is when the network is back or the token is fixed:
          // the retry these two were waiting for.
          this.requeue(entry, "retrying after restart");
        } else if (stored.failure) {
          entry.failure = { ...stored.failure, parked: true, nextRetryAt: undefined };
        }
      }
      restored++;
    }
    if (restored > 0) this.log(`restored ${restored} PR${restored === 1 ? "" : "s"}.`);
  }

  /**
   * Write one PR's record: ready with what it built, or failed with why. A
   * queued or building one is not written — there is nothing built yet, and
   * a build is a promise on this process's event loop, which does not
   * survive the process; it comes back when it is added again, as the
   * watcher does on its next poll. A write that fails is logged and
   * otherwise ignored — a server that cannot keep its memory should still
   * serve what it holds.
   */
  private persist(entry: Entry): void {
    if (!this.persistence) return;
    let record: StoredPr;
    if (entry.state === "ready" && entry.built && entry.readyAt !== undefined) {
      const built = entry.built;
      record = {
        version: 1,
        state: "ready",
        owner: entry.owner,
        repo: entry.repo,
        number: entry.number,
        options: entry.options,
        facts: entry.facts,
        addedAt: entry.addedAt,
        readyAt: entry.readyAt,
        built,
      };
    } else if (entry.state === "failed") {
      record = {
        version: 1,
        state: "failed",
        owner: entry.owner,
        repo: entry.repo,
        number: entry.number,
        options: entry.options,
        facts: entry.facts,
        addedAt: entry.addedAt,
        error: entry.error ?? "failed",
        ...(entry.failedAt !== undefined ? { failedAt: entry.failedAt } : {}),
        ...(entry.failure
          ? {
              failure: {
                kind: entry.failure.kind,
                attempts: entry.failure.attempts,
                firstFailedAt: entry.failure.firstFailedAt,
                ...(entry.failure.headSha ? { headSha: entry.failure.headSha } : {}),
              },
            }
          : {}),
      };
    } else {
      return;
    }
    try {
      this.persistence.store.save(record);
    } catch (error) {
      this.log(`${entry.key}: could not save — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private view(entry: Entry): PrView {
    const input = entry.built?.input;
    return {
      key: entry.key,
      owner: entry.owner,
      repo: entry.repo,
      number: entry.number,
      prUrl: entry.prUrl,
      state: entry.state,
      role: entry.facts.role ?? "review",
      approved: entry.facts.approved ?? false,
      approvers: entry.facts.approvers ?? [],
      ...(entry.facts.author ? { author: entry.facts.author } : {}),
      ...(entry.facts.draft !== undefined ? { draft: entry.facts.draft } : {}),
      path: prMountPath(entry),
      ...(input?.prTitle ? { title: input.prTitle } : {}),
      ...(input ? { slices: input.slices.length } : {}),
      ...(input ? { graphs: input.slices.filter((s) => s.graph).length } : {}),
      ...(input ? { size: explorerSize(input) } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.failure ? { failure: { ...entry.failure } } : {}),
      addedAt: entry.addedAt,
      ...(entry.readyAt !== undefined ? { readyAt: entry.readyAt } : {}),
      ...(entry.built?.headSha ? { headSha: entry.built.headSha } : {}),
      log: [...entry.log],
      live: entry.session !== undefined,
    };
  }
}
