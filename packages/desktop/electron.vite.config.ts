import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { ProxyOptions } from "vite";

/**
 * Three bundles: the main process (which runs the review server and the
 * watcher), the preload (the typed bridge the pages use for settings), and
 * the renderer (the React pages). The workspace packages are bundled into
 * main rather than externalized: they ship as TypeScript source and a
 * packaged app has no tsx to run them with.
 */
const daemon = `http://127.0.0.1:${process.env.DEEP_REVIEW_PORT ?? 7331}`;

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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@deep-review/review", "@deep-review/call-graph", "@deep-review/pr", "@deep-review/slicer"] })],
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
