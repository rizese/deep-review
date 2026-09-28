/**
 * The server the visual baselines are taken against: four PRs of one repo
 * in the four states a card can be in — ready and approved, ready and
 * authored, building forever, failed with a setup problem — on a fixed
 * port, with nothing persisted and no network. Run by Playwright's
 * webServer before the specs.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "../../packages/pr/src/index.js";
import type { BuildPr } from "../../packages/review/src/registry.js";
import { startNavServer } from "../../packages/review/src/serve.js";
import { fileURLToPath } from "node:url";
import { fixtureInput, libText, useText } from "./explorerInput.js";

const PORT = Number(process.env.E2E_PORT ?? 4545);

const headDir = mkdtempSync(path.join(os.tmpdir(), "e2e-head-"));
writeFileSync(path.join(headDir, "lib.ts"), libText.join("\n"));
writeFileSync(path.join(headDir, "use.ts"), useText.join("\n"));

const build: BuildPr = ({ prUrl, navBase }, log) => {
  const number = Number(prUrl.split("/").pop());
  if (number === 3) {
    log("Checked out aaaaaaaa..bbbbbbbb (merge base to head).");
    log("Diff: 4 hunks, 61 changed lines.");
    log("Prompt is ~3,412 tokens.");
    log("    ...thinking (12s elapsed, ~400 reasoning chars so far)");
    return new Promise(() => {});
  }
  if (number === 4) return Promise.reject(new ConfigError("GITHUB_TOKEN is not set; it is needed to find your PRs."));
  const input = fixtureInput(number, navBase);
  return Promise.resolve({ input, headDir, headSha: "b".repeat(40), baseSha: "a".repeat(40) });
};

// The client build beside this checkout: the pages are its to render.
const uiDir = fileURLToPath(new URL("../../packages/desktop/out/renderer/", import.meta.url));
const server = await startNavServer({ build, port: PORT, uiDir, retry: { transientDelaysMs: [3_600_000], buildRetries: 0, buildDelayMs: 3_600_000, transientMaxMs: 3_600_000 } });
const ref = (number: number) => ({ owner: "acme", repo: "widgets", number });
server.add(ref(1), {}, { role: "review", author: "sam", approved: true, approvers: ["alex"], headSha: "b".repeat(40) });
server.add(ref(2), {}, { role: "authored", author: "me", draft: true, approved: false });
server.add(ref(3), {}, { role: "review", author: "kim" });
server.add(ref(4), {}, { role: "authored", author: "me" });
console.log(`fixture server on ${server.url}`);
