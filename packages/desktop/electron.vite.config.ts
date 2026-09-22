import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { loadEnv, type ProxyOptions } from "vite";

/**
 * Three bundles: the main process (which runs the review server and the
 * watcher), the preload (the typed bridge the pages use for settings), and
 * the renderer (the React pages). The workspace packages are bundled into
 * main rather than externalized: they ship as TypeScript source and a
 * packaged app has no tsx to run them with.
 */
const daemon = `http://127.0.0.1:${process.env.DEEP_REVIEW_PORT ?? 7331}`;

/**
 * The OAuth App that "Sign in with GitHub" authorizes against, baked into
 * the main bundle at build time.
 *
 * A client id is not a secret — the Device Flow has none, and this one is
 * readable in any shipped binary and in the address bar while signing in.
 * It is kept out of the repository all the same: published, it lets anyone
 * raise a consent screen carrying this app's name, and it shares this app's
 * rate limits and org approvals. So it comes from the environment, or from
 * a gitignored .env beside this config, and a build without one simply
 * leaves the field in Settings as the way to supply it.
 */
const clientId = process.env.DEEP_REVIEW_GITHUB_CLIENT_ID ?? loadEnv("", __dirname, "DEEP_REVIEW_").DEEP_REVIEW_GITHUB_CLIENT_ID ?? "";

// In development the pages come from Vite for hot reload and reach the
// server main started through this proxy, so they stay same-origin; the
// Origin header is dropped because the server refuses state changes that
// arrive from another origin.
const toDaemon: ProxyOptions = {
  target: daemon,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq) => proxyReq.removeHeader("origin"));
  },
};
const proxy: Record<string, ProxyOptions> = Object.fromEntries(
  ["/prs", "/events", "/health", "/quit", "^/pr/[^/]+/[^/]+/[0-9]+/(definition|references|panel|alive|gone)"].map((path) => [path, toDaemon]),
);

/** Shipped as TypeScript source; a packaged app has no tsx to run them with. */
const WORKSPACE = ["@deep-review/review", "@deep-review/call-graph", "@deep-review/pr", "@deep-review/slicer"];

/**
 * Packages with `"type": "module"` and no CommonJS entry. Rollup converts
 * them on the way into the bundle; left external, requiring them from the
 * CommonJS main or worker bundle throws ERR_REQUIRE_ESM.
 */
const ESM_ONLY = ["ai", "@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/xai"];

export default defineConfig({
  main: {
    define: { __GITHUB_CLIENT_ID__: JSON.stringify(clientId) },
    // The main bundles are CommonJS, so a dependency with no CommonJS entry
    // cannot be left external: `require()` of it throws ERR_REQUIRE_ESM at
    // load, which is how every build in the app died before this. The
    // workspace packages ship as TypeScript and must be bundled too.
    plugins: [externalizeDepsPlugin({ exclude: [...WORKSPACE, ...ESM_ONLY] })],
    build: {
      lib: { entry: { index: "./src/main.ts", buildWorker: "./src/buildWorker.ts" } },
      rollupOptions: { output: { entryFileNames: "[name].js" } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: "./src/preload.ts" },
      rollupOptions: { output: { entryFileNames: "index.js" } },
    },
  },
  renderer: {
    resolve: { alias: { "@renderer": resolve("src/renderer/src") } },
    // electron-vite presets a relative asset base for the renderer, meant for
    // file:// loading. These pages are always served over HTTP, from paths
    // like /pr/owner/repo/1/, where "./assets/…" resolves under the PR and
    // 404s. A post plugin puts the base back to absolute.
    plugins: [react(), { name: "deep-review:absolute-base", enforce: "post", config: () => ({ base: "/" }) }],
    server: { proxy },
  },
});
