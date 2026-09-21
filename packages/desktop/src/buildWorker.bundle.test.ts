import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const WORKER = path.join(__dirname, "../out/main/buildWorker.js");

/**
 * The worker bundle has to load under plain Node.
 *
 * The main bundles are CommonJS, and `require()` of a package with no
 * CommonJS entry throws ERR_REQUIRE_ESM at load — before the worker can
 * report anything, so the parent only ever saw "the build worker exited
 * before finishing (code 1)". That is how every build in the app failed
 * while every test passed: nothing else loads this bundle. The AI SDK
 * packages are ESM-only and are bundled rather than externalized
 * (electron.vite.config.ts); this notices if that stops being true.
 *
 * Needs a build to check, and says so rather than failing when there is
 * none.
 */
describe("the built build worker", () => {
  it.skipIf(!existsSync(WORKER))("loads under Node without requiring an ES module", async () => {
    // With no IPC channel there is no message to wait for, so it loads and
    // exits. A load failure exits non-zero with the reason on stderr.
    const { stderr } = await run(process.execPath, [WORKER], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 30_000,
    });
    expect(stderr).not.toContain("ERR_REQUIRE_ESM");
    expect(stderr).toBe("");
  });
});
