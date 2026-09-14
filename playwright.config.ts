import { defineConfig } from "@playwright/test";

/**
 * Visual baselines for the pages, against a fixture server with no network
 * and nothing persisted. The baselines are taken on this machine's fonts
 * and are compared on it; they are not meant to match another OS pixel for
 * pixel. `pnpm e2e` compares, `pnpm e2e:update` re-takes them after a
 * deliberate change.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}{ext}",
  use: {
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 4545}`,
    viewport: { width: 1280, height: 800 },
    colorScheme: "light",
  },
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.002 },
  },
  webServer: {
    command: "pnpm --filter @deep-review/ui build && pnpm exec tsx e2e/fixtures/serve.ts",
    url: `http://127.0.0.1:${process.env.E2E_PORT ?? 4545}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
