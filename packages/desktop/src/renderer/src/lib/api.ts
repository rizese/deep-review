/**
 * The server as the client sees it: the JSON it answers with and the
 * routes it answers on. Types come from the server package so they cannot
 * drift; nothing of its runtime is imported.
 */
import type { PrFacts, PrFailure, PrState, PrView, RegistryEvent } from "@deep-review/review/api";

export type { PrFacts, PrFailure, PrState, PrView, RegistryEvent };

export async function listPrs(): Promise<PrView[]> {
  const res = await fetch("/prs", { cache: "no-store" });
  if (!res.ok) throw new Error(`the server said ${res.status}`);
  return ((await res.json()) as { prs: PrView[] }).prs;
}

export async function addPr(ref: { owner: string; repo: string; number: number }): Promise<PrView> {
  const res = await fetch("/prs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ref),
  });
  const body = (await res.json()) as { pr?: PrView; why?: string };
  if (!res.ok || !body.pr) throw new Error(body.why ?? `the server said ${res.status}`);
  return body.pr;
}

export async function forgetPr(key: string): Promise<void> {
  await fetch(`/prs/${encodeURIComponent(key)}`, { method: "DELETE" });
}

/** `owner/repo#number` taken apart. */
export function parseKey(key: string): { owner: string; repo: string; number: number } | null {
  const slash = key.indexOf("/");
  const hash = key.lastIndexOf("#");
  if (slash < 0 || hash < slash) return null;
  return { owner: key.slice(0, slash), repo: key.slice(slash + 1, hash), number: Number(key.slice(hash + 1)) };
}

/** A GitHub PR URL taken apart, or null. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}
