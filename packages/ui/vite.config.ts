import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The client app. In development Vite serves it and proxies every server
 * route to the running daemon on 7331; built, the daemon serves `dist/`
 * itself, so `pr-review` needs no second process.
 */
const daemon = `http://127.0.0.1:${process.env.DEEP_REVIEW_PORT ?? 7331}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/prs": daemon,
      "/events": daemon,
      "/health": daemon,
      "/quit": daemon,
      // Symbol questions live under a PR's own prefix.
      "^/pr/[^/]+/[^/]+/[0-9]+/(definition|references|panel|alive|gone)": daemon,
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
