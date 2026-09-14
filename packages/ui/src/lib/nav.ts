/**
 * Every question the explorer asks the navigation server, and what it
 * remembers of the answers. A port of the fetch half of the page's former explorer nav script:
 * where a symbol is defined (`/definition`), who calls it (`/references`),
 * what a definition's panel looks like (`/panel`) — each asked once, the
 * first time a reader wants it, and resolved against the prefix this PR is
 * mounted under so one server can answer for several PRs.
 */
import type { DefinitionAnswer, DefinitionResult, ReferenceList } from "./callGraph.js";

export interface PanelAnswer {
  id: string;
  name: string;
  html: string;
}

/** Names of panels opened through the server, for the rails and the history trail. */
export const defNames = new Map<string, string>();

/** Panels the server has rendered for this page, by panel id. */
const panels = new Map<string, PanelAnswer | null>();
const references = new Map<string, ReferenceList | null>();

function navUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return trimmed + path;
}

function overHttp(): boolean {
  return location.protocol === "http:" || location.protocol === "https:";
}

/** One round trip; null when there is no server (a static copy) or it hiccuped. */
async function navFetch<T>(base: string, path: string): Promise<T | null> {
  if (!overHttp()) return null;
  try {
    const res = await fetch(navUrl(base, path), { cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Like navFetch, but says whether the round trip reached the server: a
 * hiccup is not the same as "no definition here", and a caller that caches
 * its result must not remember one as the other.
 */
async function navFetchTried<T>(base: string, path: string): Promise<{ ok: boolean; data: T | null }> {
  if (!overHttp()) return { ok: true, data: null };
  try {
    const res = await fetch(navUrl(base, path), { cache: "no-store" });
    if (!res.ok) throw new Error("bad status");
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, data: null };
  }
}

/**
 * Say hello as the page loads — after a reload that is what cancels the
 * goodbye the previous page sent — and goodbye as it leaves, so this PR's
 * language services can be let go without touching anybody else's.
 */
export function watchPageLife(base: string): () => void {
  if (!overHttp()) return () => {};
  void fetch(navUrl(base, "/alive"), { cache: "no-store" }).catch(() => {
    // No server behind this page; nothing to tell.
  });
  const bye = (): void => {
    try {
      navigator.sendBeacon?.(navUrl(base, "/gone"));
    } catch {
      // Nothing to tell.
    }
  };
  window.addEventListener("pagehide", bye);
  return () => {
    window.removeEventListener("pagehide", bye);
  };
}

export async function definitionAt(
  base: string,
  at: { file: string; line: number; column: number },
): Promise<{ ok: boolean; answer: DefinitionAnswer | null; why: string }> {
  const url = `/definition?file=${encodeURIComponent(at.file)}&line=${at.line}&col=${at.column}`;
  const tried = await navFetchTried<DefinitionResult>(base, url);
  if (!tried.ok) return { ok: false, answer: null, why: "" };
  const data = tried.data;
  const hit = data && "id" in data ? data : null;
  if (hit) defNames.set(hit.panelId, hit.name);
  return { ok: true, answer: hit, why: data && "why" in data ? data.why : "no navigation server" };
}

export async function referencesFor(base: string, id: string): Promise<ReferenceList | null> {
  const known = references.get(id);
  if (known !== undefined) return known;
  const refs = await navFetch<ReferenceList>(base, `/references?id=${encodeURIComponent(id)}`);
  if (refs) references.set(id, refs);
  return refs;
}

/** A definition panel's HTML, fetched once and kept for every track on the page. */
export async function panelFor(base: string, id: string): Promise<PanelAnswer | null> {
  const known = panels.get(id);
  if (known !== undefined) return known;
  const answer = await navFetch<PanelAnswer>(base, `/panel?id=${encodeURIComponent(id)}`);
  if (answer?.html) {
    panels.set(id, answer);
    defNames.set(id, answer.name);
    return answer;
  }
  panels.set(id, null);
  return null;
}

/** A panel already fetched, without asking again. */
export function knownPanel(id: string): PanelAnswer | null | undefined {
  return panels.get(id);
}
