/**
 * The watcher, inside the app: the same poll the launchd job ran — hand new
 * PRs to the server, retire finished ones — on a timer in the main process,
 * where it has the app's settings and can raise a notification.
 */

import { DEFAULT_INTERVAL_MS, pollOnce } from "@deep-review/review/watcher";

export interface WatchLoop {
  /** Poll now, outside the schedule. Concurrent calls share one poll. */
  pollNow(): Promise<void>;
  stop(): void;
}

export function startWatchLoop(options: { intervalMs?: number | undefined; log: (message: string) => void }): WatchLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let inFlight: Promise<void> | null = null;
  const poll = (): Promise<void> => {
    if (!inFlight) {
      inFlight = pollOnce({ onProgress: options.log })
        .then(() => undefined)
        .catch((error: unknown) => options.log(`poll failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
  const timer = setInterval(() => void poll(), intervalMs);
  void poll();
  return {
    pollNow: poll,
    stop: () => clearInterval(timer),
  };
}
