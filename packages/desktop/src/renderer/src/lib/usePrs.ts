import { useEffect, useState } from "react";
import { listPrs, type PrView, type RegistryEvent } from "./api.js";

/**
 * Every PR the server holds, kept current from its event stream: a snapshot
 * on connect, then one event per change. The browser reconnects a dropped
 * stream itself and the snapshot on reconnect resets the list, so nothing
 * is missed and nothing is polled.
 */
export function usePrs(): { prs: PrView[]; ready: boolean } {
  const [prs, setPrs] = useState<Map<string, PrView>>(new Map());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    if (typeof EventSource === "undefined") {
      const poll = (): void => {
        void listPrs().then((list) => {
          if (!alive) return;
          setPrs(new Map(list.map((pr) => [pr.key, pr])));
          setReady(true);
        });
      };
      poll();
      const timer = setInterval(poll, 2000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }
    const events = new EventSource("/events");
    events.addEventListener("snapshot", (e) => {
      const { prs: list } = JSON.parse((e as MessageEvent).data) as { prs: PrView[] };
      setPrs(new Map(list.map((pr) => [pr.key, pr])));
      setReady(true);
    });
    events.addEventListener("pr", (e) => {
      const { pr } = JSON.parse((e as MessageEvent).data) as Extract<RegistryEvent, { type: "pr" }>;
      setPrs((prev) => new Map(prev).set(pr.key, pr));
    });
    events.addEventListener("removed", (e) => {
      const { key } = JSON.parse((e as MessageEvent).data) as Extract<RegistryEvent, { type: "removed" }>;
      setPrs((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    });
    return () => {
      alive = false;
      events.close();
    };
  }, []);
  return { prs: [...prs.values()].sort((a, b) => a.addedAt - b.addedAt), ready };
}
