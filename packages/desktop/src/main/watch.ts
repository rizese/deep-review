/**
 * The watcher, inside the app: the same poll the launchd job ran — hand new
 * PRs to the server, retire finished ones — on a timer in the main process,
 * where it has the app's settings and can raise a notification. It also
 * keeps the watcher's health in one place, so the pages can say whether the
 * list they show is being kept current and, when it is not, why.
 */

import process from "node:process";
import { DEFAULT_INTERVAL_MS, pollOnce, readWatcherState } from "@deep-review/review/watcher";
import { readWatchConfig } from "@deep-review/review/watchConfig";
import type { WatchStatus } from "../types/electronAPI.js";

export interface WatchLoop {
  /** Poll now, outside the schedule. Concurrent calls share one poll. */
  pollNow(): Promise<void>;
  /** How the watcher stands right now. */
  status(): WatchStatus;
  /** The token or the watch list changed: look again and tell the listener. */
  refresh(): void;
  stop(): void;
}

export const NO_TOKEN = "no GitHub token";

export function hasGithubToken(): boolean {
  return Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
}

export function startWatchLoop(options: {
  intervalMs?: number | undefined;
  log: (message: string) => void;
  onStatus?: ((status: WatchStatus) => void) | undefined;
}): WatchLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let inFlight: Promise<void> | null = null;
  let polling = false;
  // The state file carries the last poll's outcome across launches, so the
  // pages have something to say before the first poll here lands.
  const saved = readWatcherState();
  let lastPollAt: number | null = saved.lastPollAt ?? null;
  let lastError: string | null = saved.lastError ?? null;

  const status = (): WatchStatus => ({
    hasToken: hasGithubToken(),
    repos: readWatchConfig().repos.length,
    polling,
    lastPollAt,
    lastError,
  });
  const tell = (): void => options.onStatus?.(status());

  const poll = (): Promise<void> => {
    if (inFlight) return inFlight;
    // Without a token every query fails the same way; say so instead of asking.
    if (!hasGithubToken()) {
      if (lastError !== NO_TOKEN) options.log("not polling GitHub: no token is set.");
      lastError = NO_TOKEN;
      tell();
      return Promise.resolve();
    }
    polling = true;
    tell();
    inFlight = pollOnce({ onProgress: options.log })
      .then((state) => {
        lastPollAt = state.lastPollAt ?? Date.now();
        lastError = state.lastError ?? null;
      })
      .catch((error: unknown) => {
        lastPollAt = Date.now();
        lastError = error instanceof Error ? error.message : String(error);
        options.log(`poll failed: ${lastError}`);
      })
      .finally(() => {
        polling = false;
        inFlight = null;
        tell();
      });
    return inFlight;
  };
  const timer = setInterval(() => void poll(), intervalMs);
  void poll();
  return {
    pollNow: poll,
    status,
    refresh: tell,
    stop: () => clearInterval(timer),
  };
}
