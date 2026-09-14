/**
 * The build itself: slice the PR, walk each slice's call graph, render the
 * page under the prefix the server will mount it at. This is the work the
 * server hands to a child process (see buildFork.ts) — a clone and a
 * language-service run take minutes of CPU, and on the server's own event
 * loop they made it deaf for that long.
 *
 * The slice JSON of a fresh run is kept under the state dir, and a kept one
 * whose head commit still matches the PR's is reused instead of paying for
 * the model again — a restart, or re-adding an unchanged PR, costs no
 * slicing. An explicit slice JSON (--slices) is trusted as given, no head
 * check.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { renderSliceExplorerHtml } from "@deep-review/call-graph";
import { fetchPrInfo, parsePrUrl } from "@deep-review/pr";
import { loadSliceReport, slicePr, writeSliceReport } from "@deep-review/slicer";
import { explorerInputFromReport } from "./build.js";
import { cachedSliceFile, repoWorkDir } from "./paths.js";
import type { BuildPr, BuiltPr } from "./registry.js";

/** The head commit a saved slice report was made from, or null if unreadable. */
function reportHeadSha(file: string): string | null {
  try {
    return loadSliceReport(file).pr.headSha;
  } catch {
    return null;
  }
}

export const runBuild: BuildPr = async ({ prUrl, navBase, options }, log): Promise<BuiltPr> => {
  const ref = parsePrUrl(prUrl);
  const workDir = repoWorkDir(ref);
  mkdirSync(workDir, { recursive: true });

  let reportFile: string;
  if (options.slicesFile) {
    reportFile = options.slicesFile;
    log(`using slices from ${reportFile}`);
  } else {
    const info = await fetchPrInfo(ref);
    const cached = cachedSliceFile(info);
    if (existsSync(cached) && reportHeadSha(cached) === info.headSha) {
      reportFile = cached;
      log(`head unchanged at ${info.headSha.slice(0, 8)}; reusing slices from ${cached}`);
    } else {
      const report = await slicePr({
        prUrl,
        workDir,
        ...(options.model ? { model: options.model } : {}),
        onProgress: log,
      });
      mkdirSync(path.dirname(cached), { recursive: true });
      reportFile = writeSliceReport(report, cached);
      log(`slices written to ${reportFile}`);
    }
  }

  const built = await explorerInputFromReport(reportFile, {
    workDir,
    ...(options.maxGraphs !== undefined ? { maxGraphs: options.maxGraphs } : {}),
    ...(options.debugMarks ? { debugMarks: true } : {}),
    onProgress: log,
  });
  const input = { ...built.input, navBase };
  return {
    input,
    headDir: built.headDir,
    html: renderSliceExplorerHtml(input),
    headSha: built.report.pr.headSha,
    baseSha: built.report.pr.mergeBaseSha,
  };
};
