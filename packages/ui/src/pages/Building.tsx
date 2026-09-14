import { useEffect, type JSX } from "react";
import { Chrome } from "../components/Chrome.js";
import type { PrView } from "../lib/api.js";
import "../styles/source.css";
import "../styles/building.css";

/**
 * What a PR's own URL shows while it is still being built: its title, the
 * build's progress lines as they arrive, and the way back to the index. The
 * live log comes from the same event stream the index reads, so a PR turns
 * into its explorer without a reload. A port of `renderBuildingPage`.
 */
export function Building({ pr, count }: { pr: PrView; count: number }): JSX.Element {
  const failed = pr.state === "failed";
  useEffect(() => {
    document.body.classList.add("building-page");
    return () => document.body.classList.remove("building-page");
  }, []);
  useEffect(() => {
    document.title = `${pr.key} — ${failed ? "failed" : "building"}`;
  }, [pr.key, failed]);
  return (
    <>
      <Chrome count={count} />
      <main className="page">
        <header>
          <h1>{pr.title ?? pr.key}</h1>
          <div className="meta">
            <a href={pr.prUrl}>{pr.key}</a> · {failed ? "build failed" : "slicing and walking call graphs…"}
          </div>
        </header>
        {pr.error && <div className="why">{pr.error}</div>}
        <div className="log">{pr.log.join("\n") || "queued…"}</div>
        <div className="hint">
          <a href="/">← every PR on this server</a>
        </div>
      </main>
    </>
  );
}
