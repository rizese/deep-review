import { useEffect, useState, type JSX } from "react";
import type { SliceExplorerInput } from "../lib/callGraph.js";
import { go } from "../lib/route.js";
import { useHeldPrs } from "../lib/usePrs.js";
import { Building } from "./Building.js";
import { Explorer } from "./Explorer.js";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * One PR's page. The registry's own event stream says which state it is in,
 * so a PR still building shows its log and becomes its explorer in place as
 * soon as the build lands — and one dropped from the server sends the reader
 * back to the index.
 */
export function PrPage({ target }: { target: PrRef }): JSX.Element | null {
  const { prs, ready } = useHeldPrs();
  const key = `${target.owner}/${target.repo}#${target.number}`;
  const pr = prs.find((p) => p.key === key);
  const built = pr?.state === "ready";
  const [input, setInput] = useState<SliceExplorerInput | null>(null);

  // A PR this server does not hold has no page here.
  useEffect(() => {
    if (ready && !pr) go("/");
  }, [ready, pr]);

  useEffect(() => {
    if (!built) return;
    let alive = true;
    void fetch(`/prs/${encodeURIComponent(key)}/input`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<SliceExplorerInput>) : null))
      .then((body) => {
        if (alive && body) setInput(body);
      })
      .catch(() => {
        // The server is not answering; the stream will say when it is back.
      });
    return () => {
      alive = false;
    };
  }, [built, key]);

  if (!pr) return null;
  if (input) return <Explorer input={input} />;
  // Ready but the input is still on its way: nothing, rather than a flash of
  // the building page for a PR that is already built.
  if (built) return null;
  return <Building pr={pr} />;
}
