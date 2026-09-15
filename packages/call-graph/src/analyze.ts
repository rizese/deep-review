import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DeclRef, LanguageBackend } from "./backend.js";
import { Backends } from "./backends.js";
import {
  changedPaths,
  fetchPrInfo,
  parsePrUrl,
  parseUnifiedDiff,
  prepareCheckouts,
} from "@deep-review/pr";
import { mergeGraphs, walkCallGraph, type SideGraph } from "./graph.js";
import { renamedCounterparts } from "./rename.js";
import { LspBackend, pyrightConfig } from "./lspBackend.js";
import { TsBackend } from "./tsBackend.js";
import type {
  CallPathResult,
  EmbeddedFile,
  FileDiff,
} from "./types.js";

export interface AnalyzeOptions {
  prUrl: string;
  functionName: string;
  /** Where to cache the clone + worktrees. Defaults to a per-PR tmp dir. */
  workDir?: string;
}

interface PrContext {
  info: Awaited<ReturnType<typeof fetchPrInfo>>;
  baseDir: string;
  /** The commit the PR branched from; what baseDir is checked out at. */
  mergeBaseSha: string;
  headDir: string;
  files: FileDiff[];
  preferred: Set<string>;
}

async function preparePr(options: AnalyzeOptions): Promise<PrContext> {
  const ref = parsePrUrl(options.prUrl);
  const info = await fetchPrInfo(ref);
  const { baseDir, headDir, mergeBaseSha, diffText } = prepareCheckouts(
    info,
    options.workDir,
  );
  const files = parseUnifiedDiff(diffText);
  return {
    info,
    baseDir,
    mergeBaseSha,
    headDir,
    files,
    preferred: changedPaths(files),
  };
}

/**
 * Candidate language backends for one checkout, ordered by which language
 * the PR's diff actually touches. Each backend starts lazily on first use.
 */
function createBackends(dir: string, changed: ReadonlySet<string>): LanguageBackend[] {
  const paths = [...changed];
  const hasPython = paths.some((p) => p.endsWith(".py"));
  const hasTypeScript = paths.some((p) => /\.(ts|tsx|mts|cts|js|jsx)$/.test(p));
  if (hasPython && !hasTypeScript) {
    return [new LspBackend(dir, pyrightConfig()), new TsBackend(dir)];
  }
  if (hasPython) {
    return [new TsBackend(dir), new LspBackend(dir, pyrightConfig())];
  }
  return [new TsBackend(dir)];
}

interface FoundBackend {
  backend: LanguageBackend;
  decl: DeclRef;
}

async function findAcrossBackends(
  backends: LanguageBackend[],
  name: string,
  preferred: ReadonlySet<string>,
): Promise<FoundBackend | null> {
  for (const backend of backends) {
    const decl = await backend.findFunction(name, preferred).catch(() => null);
    if (decl) return { backend, decl };
  }
  return null;
}

interface FoundFunction extends FoundBackend {
  /** The name the function has on this side (differs when the PR renamed it). */
  name: string;
}

/**
 * Locate `name` on one side of the PR, falling back to the name it had (or
 * gained) across a rename visible in the diff — so the "before" side of a
 * renamed function is still found and walked.
 */
async function findWithRenames(
  backends: LanguageBackend[],
  name: string,
  preferred: ReadonlySet<string>,
  files: FileDiff[],
  side: "old" | "new",
): Promise<FoundFunction | null> {
  const direct = await findAcrossBackends(backends, name, preferred);
  if (direct) return { ...direct, name };
  for (const counterpart of renamedCounterparts(files, name, side)) {
    const found = await findAcrossBackends(backends, counterpart, preferred);
    if (found) return { ...found, name: counterpart };
  }
  return null;
}

async function embedFiles(
  backend: LanguageBackend,
  side: "before" | "after",
  paths: Iterable<string>,
): Promise<EmbeddedFile[]> {
  const embedded: EmbeddedFile[] = [];
  for (const p of new Set(paths)) {
    const file = await backend.fileInfo(p).catch(() => null);
    if (file) embedded.push({ side, path: p, ...file });
  }
  return embedded;
}

/**
 * Embed head-side files with their symbol tables, running whichever
 * language service understands each; a file no service covers (Markdown,
 * config) is embedded as plain lines. Paths that do not exist in the
 * checkout — deleted by the PR — are skipped.
 */
export async function embedHeadFiles(headDir: string, paths: Iterable<string>): Promise<EmbeddedFile[]> {
  const backends = new Backends(headDir);
  const embedded: EmbeddedFile[] = [];
  try {
    for (const p of new Set(paths)) {
      const full = path.resolve(headDir, p);
      if (!full.startsWith(path.resolve(headDir) + path.sep) || !existsSync(full)) continue;
      const info = await backends.for(p)?.fileInfo(p).catch(() => null);
      embedded.push({
        side: "after",
        path: p,
        ...(info ?? { lines: readFileSync(full, "utf8").split("\n"), symbols: [] }),
      });
    }
  } finally {
    backends.dispose();
  }
  return embedded;
}

export interface PathOptions extends AnalyzeOptions {
  /** How many changed functions deep to walk in each direction (default 8). */
  maxDepth?: number;
}

/**
 * Recursively walk the call graph out from the named function on both sides
 * of the PR, expanding through changed functions until hitting unchanged
 * boundaries. Returns a graph of nodes and caller→callee edges that a
 * navigator UI can traverse in either direction.
 */
export async function analyzePrCallPath(
  options: PathOptions,
): Promise<CallPathResult> {
  const { info, baseDir, mergeBaseSha, headDir, files, preferred } =
    await preparePr(options);
  const limits = {
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  };

  const allBackends: LanguageBackend[] = [];
  try {
    const sideFor = async (
      dir: string,
      side: "old" | "new",
    ): Promise<{ backend: LanguageBackend; graph: SideGraph } | null> => {
      const backends = createBackends(dir, preferred);
      allBackends.push(...backends);
      const found = await findWithRenames(
        backends,
        options.functionName,
        preferred,
        files,
        side,
      );
      if (!found) return null;
      const graph = await walkCallGraph(found.backend, found.decl, files, side, limits);
      return { backend: found.backend, graph };
    };

    const baseSide = await sideFor(baseDir, "old");
    const headSide = await sideFor(headDir, "new");
    if (!baseSide && !headSide) {
      throw new Error(
        `Function "${options.functionName}" was not found in either revision of ${info.owner}/${info.repo}`,
      );
    }

    const { rootId, nodes, edges } = mergeGraphs(
      files,
      baseSide?.graph ?? null,
      headSide?.graph ?? null,
    );

    // Embed every node's file so panels can expand context anywhere.
    const embedded: EmbeddedFile[] = [];
    for (const [side, data] of [
      ["before", baseSide],
      ["after", headSide],
    ] as const) {
      if (!data) continue;
      embedded.push(
        ...(await embedFiles(
          data.backend,
          side,
          [...data.graph.nodes.values()].map((n) => n.snapshot.file),
        )),
      );
    }

    return {
      prUrl: options.prUrl,
      prTitle: info.title,
      functionName: options.functionName,
      base: { ref: info.baseRef, sha: mergeBaseSha },
      head: { ref: `pull/${info.number}/head`, sha: info.headSha },
      rootId,
      nodes,
      edges,
      files: embedded,
    };
  } finally {
    for (const backend of allBackends) backend.dispose();
  }
}
