/**
 * Where the server remembers its PRs between runs: one JSON file per PR
 * under `<state dir>/prs/`, written whole and atomically (to a temp file,
 * then renamed), and holding what a build produced minus the page itself.
 *
 * One file per PR because the things that change — a build finishing, an
 * approval landing, a PR being retired — each concern one PR, and rewriting
 * a single small file is cheap enough to do on every such change. The old
 * layout was one `registry.json` for everything, rewritten in full each
 * time; with six PRs it had reached 30 MB, two thirds of it rendered HTML
 * that the server discarded on restart anyway because it re-renders from
 * the input. The page is derived, so it is not stored; the input is the
 * truth about the PR and is.
 *
 * Failed PRs are stored too. A failure used to vanish on restart, while the
 * watcher went on believing it had handed the PR over, so the PR was gone
 * for good. Kept, it comes back as failed, and can be retried.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SliceExplorerInput } from "@deep-review/call-graph";
import type { PrRef } from "@deep-review/pr";
import type { AddOptions, PrFacts } from "./registry.js";

/** What a build produced that is worth keeping: everything but the page, which is re-rendered. */
export interface StoredBuild {
  input: SliceExplorerInput;
  /** The PR's head checkout, which the language services read. */
  headDir: string;
  /** The head commit this build was made from; a moved head means a stale build. */
  headSha?: string | undefined;
  /** The merge-base commit the base checkout is at. */
  baseSha?: string | undefined;
}

export interface StoredPr extends PrRef {
  version: 1;
  state: "ready" | "failed";
  options: AddOptions;
  facts: PrFacts;
  addedAt: number;
  readyAt?: number | undefined;
  built?: StoredBuild | undefined;
  /** Why the build failed, when it did. */
  error?: string | undefined;
  failedAt?: number | undefined;
}

export interface PrStore {
  /** Every PR remembered, in no particular order; records that cannot be trusted are skipped. */
  load(): StoredPr[];
  save(pr: StoredPr): void;
  remove(ref: PrRef): void;
}

/** Enough of a record's shape to trust it; a half-written file yields nothing rather than a crash later. */
export function isStoredPr(record: unknown): record is StoredPr {
  if (typeof record !== "object" || record === null) return false;
  const r = record as Partial<StoredPr>;
  if (
    typeof r.owner !== "string" ||
    typeof r.repo !== "string" ||
    !Number.isInteger(r.number) ||
    typeof r.addedAt !== "number" ||
    typeof r.options !== "object" ||
    r.options === null ||
    typeof r.facts !== "object" ||
    r.facts === null
  ) {
    return false;
  }
  if (r.state === "ready") {
    return (
      typeof r.readyAt === "number" &&
      typeof r.built === "object" &&
      r.built !== null &&
      typeof r.built.headDir === "string" &&
      typeof r.built.input === "object" &&
      r.built.input !== null &&
      Array.isArray(r.built.input.slices)
    );
  }
  if (r.state === "failed") return typeof r.error === "string";
  return false;
}

/** `owner__repo__number.json`, with the parts escaped so a slash or a space in a name cannot leave the directory. */
function fileFor(dir: string, ref: PrRef): string {
  return path.join(dir, `${encodeURIComponent(ref.owner)}__${encodeURIComponent(ref.repo)}__${ref.number}.json`);
}

export interface FileStoreOptions {
  /**
   * The previous single-file layout, read once and converted: each PR it
   * holds is written to the directory (without its HTML) and the file is
   * renamed aside, so the conversion happens exactly once.
   */
  legacyFile?: string | undefined;
  onProblem?: ((message: string) => void) | undefined;
}

export function fileStore(dir: string, options: FileStoreOptions = {}): PrStore {
  const problem = options.onProblem ?? (() => {});

  const save = (pr: StoredPr): void => {
    mkdirSync(dir, { recursive: true });
    const file = fileFor(dir, pr);
    // Whole and atomic: a crash between the two steps leaves either the old
    // file or the new one, never half of one.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(pr));
    renameSync(tmp, file);
  };

  const migrateLegacy = (): void => {
    const legacy = options.legacyFile;
    if (!legacy || !existsSync(legacy)) return;
    let prs: unknown[] = [];
    try {
      const parsed = JSON.parse(readFileSync(legacy, "utf8")) as { prs?: unknown };
      if (Array.isArray(parsed.prs)) prs = parsed.prs;
    } catch (error) {
      problem(`${legacy}: could not be read (${error instanceof Error ? error.message : String(error)}); starting empty.`);
    }
    let converted = 0;
    for (const record of prs) {
      const r = record as {
        owner?: unknown;
        repo?: unknown;
        number?: unknown;
        options?: unknown;
        facts?: unknown;
        addedAt?: unknown;
        readyAt?: unknown;
        built?: { input?: unknown; headDir?: unknown; headSha?: unknown; baseSha?: unknown } | null;
      };
      const candidate: StoredPr = {
        version: 1,
        state: "ready",
        owner: r.owner as string,
        repo: r.repo as string,
        number: r.number as number,
        options: (r.options ?? {}) as AddOptions,
        facts: (r.facts ?? {}) as PrFacts,
        addedAt: r.addedAt as number,
        readyAt: r.readyAt as number,
        ...(r.built
          ? {
              built: {
                input: r.built.input as SliceExplorerInput,
                headDir: r.built.headDir as string,
                ...(typeof r.built.headSha === "string" ? { headSha: r.built.headSha } : {}),
                ...(typeof r.built.baseSha === "string" ? { baseSha: r.built.baseSha } : {}),
              },
            }
          : {}),
      };
      if (isStoredPr(candidate)) {
        save(candidate);
        converted++;
      }
    }
    try {
      renameSync(legacy, `${legacy}.migrated`);
    } catch {
      // Left in place, it would be converted again next start — harmless, since save() overwrites.
    }
    problem(`converted ${converted} PR${converted === 1 ? "" : "s"} from ${path.basename(legacy)} to ${dir}.`);
  };

  return {
    load() {
      migrateLegacy();
      if (!existsSync(dir)) return [];
      const prs: StoredPr[] = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(dir, name);
        try {
          const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
          if (isStoredPr(parsed)) prs.push(parsed);
          else problem(`${file}: not a PR record; skipped.`);
        } catch (error) {
          problem(`${file}: could not be read (${error instanceof Error ? error.message : String(error)}); skipped.`);
        }
      }
      return prs;
    },
    save,
    remove(ref) {
      rmSync(fileFor(dir, ref), { force: true });
    },
  };
}

/** A store that forgets on exit — for tests, and for a server run that should leave nothing behind. */
export function memoryStore(): PrStore {
  const prs = new Map<string, StoredPr>();
  const keyOf = (ref: PrRef): string => `${ref.owner}/${ref.repo}#${ref.number}`;
  return {
    load: () => [...prs.values()],
    save: (pr) => void prs.set(keyOf(pr), pr),
    remove: (ref) => void prs.delete(keyOf(ref)),
  };
}
