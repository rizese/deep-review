#!/usr/bin/env node
/**
 * Put Deep Review back to a first run.
 *
 * Two places hold state, and clearing one without the other is how you get
 * a watcher that believes it has already handed over PRs the server no
 * longer has, and so hands over nothing ever again:
 *
 *   ~/.deep-review                     the server's PR store, the watcher's
 *                                      memory, the searches, checkouts, logs
 *   …/Application Support/@deep-review the app's encrypted settings (your
 *                                      GitHub token and model keys), the
 *                                      Dock badge's read marks, window state
 *
 * Usage:
 *   pnpm reset                 clear both; a true first run
 *   pnpm reset --keep-keys     keep the token and model keys; clear the rest
 *   pnpm reset --dry-run       say what would go, touch nothing
 *   pnpm reset --yes           do not ask
 */

import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const flags = new Set(process.argv.slice(2));
const keepKeys = flags.has("--keep-keys");
const dryRun = flags.has("--dry-run");
const assumeYes = flags.has("--yes") || flags.has("-y");

const unknown = [...flags].filter((f) => !["--keep-keys", "--dry-run", "--yes", "-y"].includes(f));
if (unknown.length) {
  console.error(`Unknown option ${unknown.join(", ")}. Try --keep-keys, --dry-run or --yes.`);
  process.exit(2);
}

const HOME = os.homedir();
const stateDir = process.env.DEEP_REVIEW_HOME ?? path.join(HOME, ".deep-review");
/** Where Electron keeps this app's data, by platform; overridable for tests. */
function appDataDir() {
  if (process.env.DEEP_REVIEW_USER_DATA) return process.env.DEEP_REVIEW_USER_DATA;
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "@deep-review");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming"), "@deep-review");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, ".config"), "@deep-review");
}
const userData = appDataDir();
const settingsFile = path.join(userData, "desktop", "settings.encrypted");

/**
 * Refuse to delete anything that is not one of ours under this home. A typo
 * in DEEP_REVIEW_HOME should not cost somebody their documents.
 */
function safeToRemove(target) {
  const resolved = path.resolve(target);
  if (resolved === path.resolve(HOME) || resolved === path.parse(resolved).root) return false;
  if (!resolved.startsWith(`${path.resolve(HOME)}${path.sep}`) && !resolved.startsWith(path.resolve(os.tmpdir()))) return false;
  return resolved.includes("deep-review");
}

/** The server answering means the app is up, and it would write its state back over ours. */
async function serverRunning() {
  const port = process.env.DEEP_REVIEW_PORT ?? 7331;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const targets = [
  { path: stateDir, what: "PR pages, the watcher's memory, searches, checkouts, logs" },
  { path: userData, what: keepKeys ? "read marks and window state (keys kept)" : "GitHub token, model keys, read marks, window state" },
].filter((t) => existsSync(t.path));

if (targets.length === 0) {
  console.log("Nothing to clear; Deep Review holds no state.");
  process.exit(0);
}

// Checked before anything is printed, so a mistyped DEEP_REVIEW_HOME never
// gets as far as announcing a plan to delete somebody's documents.
for (const target of targets) {
  if (!safeToRemove(target.path)) {
    console.error(`Refusing to touch ${target.path}: it does not look like Deep Review's own directory.`);
    process.exit(1);
  }
}

// A dry run touches nothing, so it is worth answering even with the app up.
if (!dryRun && (await serverRunning())) {
  console.error("Deep Review is running, and would write its state back over this. Quit it first.");
  process.exit(1);
}

console.log(keepKeys ? "Clearing everything but your keys:\n" : "Clearing everything:\n");
for (const target of targets) console.log(`  ${target.path}\n    ${target.what}`);
console.log();

if (dryRun) {
  console.log("--dry-run: nothing was touched.");
  process.exit(0);
}

if (!assumeYes) {
  if (!process.stdin.isTTY) {
    console.error("Not a terminal; pass --yes to confirm.");
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Delete these? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("Left alone.");
    process.exit(0);
  }
}

// Read the keys out before the tree goes, and put them back after: simpler
// to reason about than deleting around them, and leaves nothing stale.
const keptSettings = keepKeys && existsSync(settingsFile) ? readFileSync(settingsFile) : null;

for (const target of targets) {
  rmSync(target.path, { recursive: true, force: true });
  console.log(`removed ${target.path}`);
}

if (keptSettings) {
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, keptSettings);
  console.log(`kept    ${settingsFile}`);
}

console.log(`\nDone. Start again with: pnpm dev`);
