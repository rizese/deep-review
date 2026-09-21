/**
 * What the watcher looks for, as GitHub searches.
 *
 * This file used to be a list of repos, each queried separately, and the
 * repo list was the source of truth for what you were reviewing. It made a
 * poor one: a PR waiting on you in a repo nobody had named was invisible,
 * and naming repos is work that GitHub already does. The source of truth is
 * now the search itself — the same query the address bar of github.com/pulls
 * holds — so what the app shows is what GitHub shows.
 *
 * What the repo list was protecting against is still real: a search bound to
 * nobody and nowhere returns every PR the token can see, and one night that
 * quietly handed six PRs from a personal repo to the server. So a search
 * must name a person, an owner or a repo (`checkSearch`), and one that names
 * none is skipped with a note rather than asked.
 *
 * Lives under the state dir with `watcher.json` and `server.json`, so it
 * moves with $DEEP_REVIEW_HOME like everything else.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkSearch, DEFAULT_AUTHORED_SEARCHES, DEFAULT_REVIEW_SEARCHES, type PrSearch } from "@deep-review/pr";
import { stateDir } from "./daemon.js";

export function watchConfigFile(): string {
  return path.join(stateDir(), "watch.json");
}

/**
 * The file's shape: the searches behind each tab of the index.
 *
 *   {
 *     "searches": {
 *       "review":   ["is:open is:pr archived:false draft:false assignee:@me"],
 *       "authored": ["is:open is:pr archived:false author:@me"]
 *     }
 *   }
 *
 * A list rather than one string per tab because GitHub cannot OR two
 * qualifiers in one query: "assigned to me" and "review requested from me"
 * are two searches whose answers are merged.
 */
export interface WatchConfig {
  searches: { review: string[]; authored: string[] };
}

export interface ParsedWatchConfig {
  /** Every search to run, in the order they should be merged. */
  searches: PrSearch[];
  /** The review-tab queries, as written. */
  review: string[];
  /** The My-PRs-tab queries, as written. */
  authored: string[];
  /** Whether these came from the defaults rather than from the file. */
  fromDefaults: boolean;
  /** Whether an old repo-list file was read as searches. */
  migrated: boolean;
  /** Searches that were skipped, and why — for the log, not for a crash. */
  problems: string[];
}

function defaults(): Pick<ParsedWatchConfig, "review" | "authored"> {
  return { review: [...DEFAULT_REVIEW_SEARCHES], authored: [...DEFAULT_AUTHORED_SEARCHES] };
}

/** The searches for both tabs, as one list the search call can take. */
export function searchesOf(config: Pick<ParsedWatchConfig, "review" | "authored">): PrSearch[] {
  return [
    ...config.review.map((query): PrSearch => ({ role: "review", query })),
    ...config.authored.map((query): PrSearch => ({ role: "authored", query })),
  ];
}

/** One repo's pair of searches: what the old file meant, said the new way. */
export function searchesForRepo(repo: string, review?: string | undefined, authored?: string | undefined): { review: string[]; authored: string[] } {
  const scope = `repo:${repo}`;
  return {
    review: review ? [`${review} ${scope}`] : DEFAULT_REVIEW_SEARCHES.map((q) => `${q} ${scope}`),
    authored: authored ? [`${authored} ${scope}`] : DEFAULT_AUTHORED_SEARCHES.map((q) => `${q} ${scope}`),
  };
}

/** The old repo-keyed file, read as the searches it stood for. */
function migrate(entries: Record<string, unknown>, problems: string[]): Pick<ParsedWatchConfig, "review" | "authored"> {
  const review: string[] = [];
  const authored: string[] = [];
  for (const [repo, entry] of Object.entries(entries)) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      problems.push(`${JSON.stringify(repo)} is not an owner/repo; skipped.`);
      continue;
    }
    const fields = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const own = typeof fields.query === "string" && fields.query.trim() ? fields.query.trim() : undefined;
    const ownAuthored = typeof fields.authoredQuery === "string" && fields.authoredQuery.trim() ? fields.authoredQuery.trim() : undefined;
    const pair = searchesForRepo(repo, own, ownAuthored);
    review.push(...pair.review);
    authored.push(...pair.authored);
  }
  return { review, authored };
}

/** The queries of one tab, with the unusable ones dropped and noted. */
function readList(raw: unknown, tab: string, problems: string[]): string[] | null {
  if (raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const kept: string[] = [];
  for (const value of list) {
    if (typeof value !== "string" || !value.trim()) {
      problems.push(`${tab}: a search should be a non-empty string; skipped.`);
      continue;
    }
    try {
      kept.push(checkSearch(value));
    } catch (error) {
      problems.push(`${tab}: ${error instanceof Error ? error.message : String(error)} Skipped.`);
    }
  }
  return kept;
}

/**
 * Read one parsed JSON document into the searches to run.
 *
 * Lenient about the parts that do not matter and strict about the one that
 * does: a search that is not a string, or that names nobody and nowhere, is
 * skipped with a note rather than taking the poll down with it. A document
 * with nothing usable in it falls back to the defaults, which are bound to
 * you by `@me` and so are safe to run.
 */
export function parseWatchConfig(raw: unknown): ParsedWatchConfig {
  const problems: string[] = [];
  const doc = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  let migrated = false;
  let lists: Pick<ParsedWatchConfig, "review" | "authored"> | null = null;

  const searches = doc?.searches;
  if (searches && typeof searches === "object" && !Array.isArray(searches)) {
    const shape = searches as Record<string, unknown>;
    const review = readList(shape.review, "review", problems);
    const authored = readList(shape.authored, "authored", problems);
    if (review !== null || authored !== null) {
      lists = { review: review ?? [...DEFAULT_REVIEW_SEARCHES], authored: authored ?? [...DEFAULT_AUTHORED_SEARCHES] };
    }
  } else if (searches !== undefined) {
    problems.push('"searches" should be an object with "review" and "authored" lists.');
  }

  // The old shape: a repo list. Read it as what it meant, so an upgrade
  // watches exactly what it watched yesterday.
  if (!lists) {
    const repos = doc?.repos;
    if (repos && typeof repos === "object" && !Array.isArray(repos)) {
      lists = migrate(repos as Record<string, unknown>, problems);
      migrated = true;
    } else if (repos !== undefined) {
      problems.push('"repos" should be an object keyed by owner/repo.');
    }
  }

  const empty = !lists || (lists.review.length === 0 && lists.authored.length === 0);
  const final = empty ? defaults() : lists!;
  return { ...final, searches: searchesOf(final), fromDefaults: empty, migrated: migrated && !empty, problems };
}

/**
 * What to search for right now. No file is not an error and no longer means
 * "watch nothing": it means the defaults, which ask GitHub for the PRs
 * waiting on you and the ones you opened, wherever they are. A file that
 * will not parse is the same, plus a note saying why.
 */
export function readWatchConfig(): ParsedWatchConfig {
  const file = watchConfigFile();
  if (!existsSync(file)) return parseWatchConfig(null);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ...parseWatchConfig(null), problems: [`${file} could not be read: ${why}`] };
  }
  return parseWatchConfig(raw);
}

/** Write both tabs' searches, replacing whatever the file said. */
export function writeWatchConfig(config: { review: string[]; authored: string[] }): { file: string } {
  const file = watchConfigFile();
  const doc: WatchConfig = { searches: { review: [...config.review], authored: [...config.authored] } };
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { file };
}

/**
 * Narrow both tabs to one more repo, keeping what is already there. Used by
 * `watch --repo`, which is now sugar for two repo-scoped searches.
 */
export function addWatchedRepo(repo: string): { file: string; added: boolean } {
  const current = readWatchConfig();
  const pair = searchesForRepo(repo);
  const has = pair.review.every((q) => current.review.includes(q));
  // The defaults are unscoped; narrowing to a repo replaces them rather than
  // adding to them, or the unscoped search would still bring in everything.
  const base = current.fromDefaults ? { review: [], authored: [] } : { review: current.review, authored: current.authored };
  const next = has
    ? base
    : { review: [...base.review, ...pair.review], authored: [...base.authored, ...pair.authored] };
  const { file } = writeWatchConfig(next);
  return { file, added: !has };
}

/** A starter file's contents, for the message that says where it goes. */
export function exampleWatchConfig(repo = "owner/repo"): string {
  return JSON.stringify({ searches: searchesForRepo(repo) }, null, 2);
}
