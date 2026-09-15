import { useEffect, useState, type JSX } from "react";
import { Index } from "./pages/Index.js";
import { PrPage, type PrRef } from "./pages/PrPage.js";
import { Settings } from "./pages/Settings.js";

const PR_PATH = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)\/$/;

/** A PR's mount path taken apart, or null for anything else. */
export function parsePath(path: string): PrRef | null {
  const m = PR_PATH.exec(path);
  return m ? { owner: decodeURIComponent(m[1]!), repo: decodeURIComponent(m[2]!), number: Number(m[3]) } : null;
}

/**
 * Which page this is, from the address. The index lives at `/`; every PR
 * has its own prefix, which the server mounts and serves this app from; and
 * `/settings` is the app's own page, reached by pushState rather than by
 * asking the server — so the address is read from state and kept current
 * through popstate.
 */
export function App(): JSX.Element | null {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const onPop = (): void => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  if (path === "/settings" || path === "/settings/") return <Settings />;
  const ref = parsePath(path);
  return ref ? <PrPage target={ref} /> : <Index />;
}
