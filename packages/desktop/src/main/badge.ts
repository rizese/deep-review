/**
 * The Dock badge: how many built PRs are waiting on you that you have not
 * opened. What has been opened is kept in a small file under userData —
 * `seen.json`, PR key → head commit — so the count survives a relaunch.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NavServer } from "@deep-review/review/daemon";
import { badgeText, unreadCount, type Seen } from "./unread.js";

export interface Badge {
  /** The reader opened this PR's page: it counts as read at its current head. */
  opened(key: string): void;
  stop(): void;
}

function readSeen(file: string): Seen {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Seen;
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") console.error("could not read seen.json:", error);
  }
  return {};
}

export function startBadge(nav: NavServer, options: { file: string; setBadge: (text: string) => void }): Badge {
  const seen = readSeen(options.file);
  const save = (): void => {
    mkdirSync(path.dirname(options.file), { recursive: true });
    writeFileSync(options.file, `${JSON.stringify(seen, null, 2)}\n`);
  };
  const show = (): void => options.setBadge(badgeText(unreadCount(nav.registry.list(), seen)));
  const unsubscribe = nav.registry.subscribe((event) => {
    if (event.type === "removed" && event.key in seen) {
      delete seen[event.key];
      save();
    }
    show();
  });
  show();
  return {
    opened: (key) => {
      const pr = nav.registry.list().find((p) => p.key === key);
      // A PR still building is not read yet; its build will bring a head to mark.
      if (!pr || pr.state !== "ready") return;
      seen[key] = pr.headSha ?? "";
      save();
      show();
    },
    stop: () => {
      unsubscribe();
      options.setBadge("");
    },
  };
}
