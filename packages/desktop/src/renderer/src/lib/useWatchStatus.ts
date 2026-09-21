import { createContext, useContext, useEffect, useState } from "react";
import type { WatchStatus } from "../../../types/electronAPI.js";

/**
 * How the watcher stands, for the pages: null in a browser, where there is
 * no watcher to ask. The app subscribes once and every page reads it here.
 */
export const WatchStatusContext = createContext<WatchStatus | null>(null);

export function useWatchStatus(): WatchStatus | null {
  return useContext(WatchStatusContext);
}

export function useWatchStatusSource(): WatchStatus | null {
  const [status, setStatus] = useState<WatchStatus | null>(null);
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api) return;
    let alive = true;
    void api.watch
      .status()
      .then((result) => {
        if (alive && result.success && result.data) setStatus(result.data);
      })
      .catch(() => {
        // The shell is not answering; the next change will come by push.
      });
    const stop = api.watch.onStatus((next) => {
      if (alive) setStatus(next);
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return status;
}

/** Whether the watcher can do its job at all; what is missing when it cannot. */
export function setupGap(status: WatchStatus | null): "token" | "searches" | null {
  if (!status) return null;
  if (!status.hasToken) return "token";
  // There are always defaults, so no searches means every one of them was
  // refused — a file someone wrote by hand and got wrong.
  if (status.searches === 0) return "searches";
  return null;
}
