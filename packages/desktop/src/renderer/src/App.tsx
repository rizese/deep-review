import { useEffect, useState, type JSX } from "react";
import { Chrome } from "./components/Chrome.js";
import { PageFade } from "./components/PageFade.js";
import { Pool } from "./components/Pool.js";
import { go, interceptLinks } from "./lib/route.js";
import { PrsContext, usePrs } from "./lib/usePrs.js";
import { Index } from "./pages/Index.js";
import { PrPage, type PrRef } from "./pages/PrPage.js";
import { Settings } from "./pages/Settings.js";

const PR_PATH = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)\/$/;

/** A PR's mount path taken apart, or null for anything else. */
export function parsePath(path: string): PrRef | null {
  const m = PR_PATH.exec(path);
  return m ? { owner: decodeURIComponent(m[1]!), repo: decodeURIComponent(m[2]!), number: Number(m[3]) } : null;
}

function pageFor(path: string): JSX.Element {
  if (path === "/settings" || path === "/settings/") return <Settings />;
  const ref = parsePath(path);
  return ref ? <PrPage target={ref} /> : <Index />;
}

/**
 * The app: one document for the life of the window. The pool behind
 * everything is mounted once and never touched again; the bar stays and
 * only changes shape; the page inside crossfades as the address changes —
 * by pushState, never by loading a new document. One event stream feeds
 * every page.
 */
export function App(): JSX.Element {
  const [path, setPath] = useState(() => location.pathname);
  const held = usePrs();
  const compact = parsePath(path) !== null;

  useEffect(() => {
    const onPop = (): void => setPath(location.pathname);
    addEventListener("popstate", onPop);
    const stopIntercepting = interceptLinks();
    // The desktop shell asks for a page — a notification clicked, the tray's
    // Settings — and gets it without a reload.
    const stopListening = window.electronAPI?.app.onNavigate?.((to) => go(to));
    return () => {
      removeEventListener("popstate", onPop);
      stopIntercepting();
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("compact", compact);
  }, [compact]);
  // Inside the desktop shell the bar is also the window's title bar.
  useEffect(() => {
    document.documentElement.classList.toggle("desktop", Boolean(window.electronAPI));
  }, []);

  return (
    <PrsContext.Provider value={held}>
      <Pool />
      <div className="app">
        <Chrome count={held.prs.length} />
        <PageFade path={path}>{pageFor(path)}</PageFade>
      </div>
    </PrsContext.Provider>
  );
}
