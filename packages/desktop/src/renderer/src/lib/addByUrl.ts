import { addPr, parsePrUrl } from "./api.js";
import { go } from "./route.js";

/**
 * A PR link arriving from anywhere — dropped on the window, pasted into
 * it, typed into the bar — becomes a PR on the server and the page for it.
 */

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** The first GitHub PR link in a piece of text: a bare URL, a uri-list, a sentence. */
export function findPrUrl(text: string): PrRef | null {
  for (const piece of text.split(/\s+/)) {
    const ref = parsePrUrl(piece);
    if (ref) return ref;
  }
  return null;
}

/** Whether the text looks like it was meant to be a link to something on GitHub. */
export function mentionsGithub(text: string): boolean {
  return /github\.com\//i.test(text);
}

export type AddOutcome = { ok: true; key: string } | { ok: false; why: string };

/** Add the PR and go to its page; the outcome is for whoever wants to say something about it. */
export async function addAndOpen(ref: PrRef): Promise<AddOutcome> {
  try {
    const pr = await addPr(ref);
    go(pr.path);
    return { ok: true, key: pr.key };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : "the server is not answering" };
  }
}

export function keyOf(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}
