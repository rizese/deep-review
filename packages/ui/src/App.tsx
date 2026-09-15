import type { JSX } from "react";
import { Index } from "./pages/Index.js";
import { PrPage, type PrRef } from "./pages/PrPage.js";

const PR_PATH = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)\/$/;

/** A PR's mount path taken apart, or null for anything else. */
export function parsePath(path: string): PrRef | null {
  const m = PR_PATH.exec(path);
  return m ? { owner: decodeURIComponent(m[1]!), repo: decodeURIComponent(m[2]!), number: Number(m[3]) } : null;
}

/**
 * Which page this is, from the address. The index lives at `/`; every PR
 * has its own prefix, which the server mounts and serves this app from.
 */
export function App(): JSX.Element | null {
  const ref = parsePath(location.pathname);
  return ref ? <PrPage target={ref} /> : <Index />;
}
