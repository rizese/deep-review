/**
 * The Dock badge: how many built PRs are waiting on you that you have not
 * opened. What has been opened is kept in a small file under userData —
 * `seen.json`, PR key → head commit — so the count survives a relaunch.
 *
 * The count is kept from the events rather than recomputed from the
 * registry. The registry emits on every progress line of every build, and
 * asking it for the full list each time rebuilds a view of every held PR —
 * which walks every changed line of every slice to size it — on the main
 * thread, to produce a number that rarely moves. Only the four fields the
 * count depends on are kept, and the badge is set only when its text
 * actually changes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NavServer } from "@deep-review/review/daemon";
import type { PrView } from "@deep-review/review/api";
import { badgeText, isUnread, type Countable, type Seen } from "./unread.js";

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

const counted = (pr: PrView): Countable => ({
  key: pr.key,
  state: pr.state,
  role: pr.role,
  approved: pr.approved,
  ...(pr.headSha === undefined ? {} : { headSha: pr.headSha }),
});

export function startBadge(nav: NavServer, options: { file: string; setBadge: (text: string) => void }): Badge {
  const seen = readSeen(options.file);
  const held = new Map<string, Countable>(nav.registry.list().map((pr) => [pr.key, counted(pr)]));
  let shown: string | null = null;

  const save = (): void => {
    mkdirSync(path.dirname(options.file), { recursive: true });
    writeFileSync(options.file, `${JSON.stringify(seen, null, 2)}\n`);
  };
  const show = (): void => {
    let count = 0;
    for (const pr of held.values()) if (isUnread(pr, seen)) count += 1;
    const text = badgeText(count);
    if (text === shown) return;
    shown = text;
    options.setBadge(text);
  };

  const unsubscribe = nav.registry.subscribe((event) => {
    if (event.type === "removed") {
      held.delete(event.key);
      if (event.key in seen) {
        delete seen[event.key];
        save();
      }
    } else {
      held.set(event.pr.key, counted(event.pr));
    }
    show();
  });
  show();
  return {
    opened: (key) => {
      const pr = held.get(key);
      // A PR still building is not read yet; its build will bring a head to mark.
      if (!pr || pr.state !== "ready") return;
      const head = pr.headSha ?? "";
      // Opening the same PR twice should not rewrite the file or the badge.
      if (seen[key] === head) return;
      seen[key] = head;
      save();
      show();
    },
    stop: () => {
      unsubscribe();
      options.setBadge("");
    },
  };
}
