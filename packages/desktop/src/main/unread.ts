/**
 * Which PRs the Dock badge counts: the ones waiting on you that are built
 * and not yet approved, and that you have not opened since they were built.
 * Opening one marks it seen at its head commit; new commits make it new
 * again. Pure, so the counting can be tested without Electron.
 */

import type { PrView } from "@deep-review/review/api";

/** PR key → the head commit it was last opened at ("" when the build had none). */
export type Seen = Record<string, string>;

/**
 * The little of a PR the count depends on. Naming it keeps the caller free
 * to hold this much and no more, rather than a whole view per PR.
 */
export type Countable = Pick<PrView, "key" | "state" | "role" | "approved" | "headSha">;

export function isUnread(pr: Countable, seen: Seen): boolean {
  if (pr.state !== "ready" || pr.role === "authored" || pr.approved) return false;
  return seen[pr.key] !== (pr.headSha ?? "");
}

export function unreadCount(prs: PrView[], seen: Seen): number {
  return prs.filter((pr) => isUnread(pr, seen)).length;
}

/** The badge's text: the count, or nothing when there is nothing to read. */
export function badgeText(count: number): string {
  return count > 0 ? String(count) : "";
}
