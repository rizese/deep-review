import {
  BuildError,
  ConfigError,
  type DeepReviewError,
  InputError,
  TransientError,
} from "./errors.js";
import type { PrRef } from "./prUrl.js";

export interface PrInfo extends PrRef {
  title: string;
  /** The PR description, as authored. Empty when the PR has no body. */
  body: string;
  author: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  cloneUrl: string;
  htmlUrl: string;
  /** Open, or closed — where "closed" covers merged too; see `merged`. */
  state: "open" | "closed";
  /** True only for a PR that was merged; a closed-unmerged PR is `closed` and false. */
  merged: boolean;
}

interface PrApiResponse {
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  user: { login: string } | null;
  base: { ref: string; sha: string; repo: { clone_url: string } };
  head: { ref: string; sha: string };
}

interface GithubRequest {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /**
   * The error to fail with when no token is available. Set it only where a
   * token is genuinely required: the REST endpoints below read public repos
   * unauthenticated, and the GraphQL one cannot be called at all.
   */
  tokenRequired?: string;
  /**
   * The message for a non-2xx response, given its status and whether a token
   * was sent. The caller knows what it asked GitHub for, so it words the
   * failure; this knows how the asking is done.
   */
  failed: (status: number, authenticated: boolean) => string;
}

/**
 * How long GitHub asked us to wait, in milliseconds, or undefined when it
 * said nothing. `Retry-After` is in seconds from now; `x-ratelimit-reset` is
 * the epoch second the quota refills at, which is the header a plain rate
 * limit comes with.
 */
function retryAfterMs(headers: Headers): number | undefined {
  const retryAfter = Number(headers.get("retry-after")?.trim());
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.round(retryAfter * 1000);
  const reset = Number(headers.get("x-ratelimit-reset")?.trim());
  if (Number.isFinite(reset)) return Math.max(0, Math.round(reset * 1000 - Date.now()));
  return undefined;
}

/**
 * A non-2xx response as the kind of failure it is. A 404 is the interesting
 * one: unauthenticated it usually means the repo is private and this machine
 * cannot see it (config), while with a token in hand it means the PR really
 * is not there (input).
 */
function httpFailure(
  message: string,
  status: number,
  authenticated: boolean,
  headers: Headers,
): DeepReviewError {
  if (status === 401 || status === 403) return new ConfigError(message);
  if (status === 404) return authenticated ? new InputError(message) : new ConfigError(message);
  if (status === 429) return new TransientError(message, { retryAfterMs: retryAfterMs(headers) });
  if (status >= 500) return new TransientError(message);
  return new InputError(message);
}

/**
 * A GraphQL `errors` array as the kind of failure it is. GraphQL answers 200
 * whatever went wrong, so the only evidence is the messages themselves: a
 * rate limit is worth retrying, a rejected token is not, and anything else is
 * a query we got wrong.
 */
function graphqlFailure(
  message: string,
  errors: { message: string; type?: string }[],
): DeepReviewError {
  const text = errors.map((e) => `${e.type ?? ""} ${e.message}`).join("; ");
  if (text.includes("RATE_LIMITED") || /rate limit/i.test(text)) return new TransientError(message);
  if (/Bad credentials|Resource not accessible/.test(text)) return new ConfigError(message);
  return new BuildError(message);
}

/**
 * One call to GitHub. Owns the two names its token goes by, the headers
 * every endpoint wants, and the turn from a non-2xx response into an Error,
 * so the callers below are left holding only their own question.
 *
 * A failure of the fetch itself is deliberately not caught: node throws a
 * `TypeError` carrying the undici code, which `failureKindOf` reads as the
 * transient network failure it is, and wrapping it would only bury that.
 */
async function githubFetch(url: string, request: GithubRequest): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token && request.tokenRequired) throw new ConfigError(request.tokenRequired);
  const res = await fetch(url, {
    ...(request.method !== undefined ? { method: request.method } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...request.headers,
    },
  });
  if (!res.ok) {
    throw httpFailure(
      request.failed(res.status, Boolean(token)),
      res.status,
      Boolean(token),
      res.headers,
    );
  }
  return res.json();
}

/** Fetch PR metadata. Uses GITHUB_TOKEN / GH_TOKEN when set (needed for private repos). */
export async function fetchPrInfo(ref: PrRef): Promise<PrInfo> {
  const pr = (await githubFetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
    {
      failed: (status, authenticated) =>
        `GitHub API returned ${status} for ${ref.owner}/${ref.repo}#${ref.number}` +
        (status === 404 && !authenticated
          ? " (private repo? set GITHUB_TOKEN)"
          : ""),
    },
  )) as PrApiResponse;
  return {
    ...ref,
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user?.login ?? "",
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    cloneUrl: pr.base.repo.clone_url,
    htmlUrl: pr.html_url,
    state: pr.state,
    merged: pr.merged,
  };
}

/** Which list a watched PR came from: waiting on your review, or authored by you. */
export type PrRole = "review" | "authored";

/** One open PR the watcher found, as GitHub's search reports it. */
export interface AssignedPr extends PrRef {
  title: string;
  htmlUrl: string;
  /** When the PR was last touched, ISO 8601 — the watcher's re-dispatch signal. */
  updatedAt: string;
  draft: boolean;
  /** Which list it came from; a PR in both is yours, and `authored` wins. */
  role: PrRole;
  author: string;
  /**
   * Whether the PR carries an approval right now: GitHub's own review
   * decision says so, or — where the branch requires no review and the
   * decision is therefore null — at least one reviewer's latest word is an
   * approval and nobody's is a request for changes.
   */
  approved: boolean;
  /** Reviewers whose latest opinionated review is an approval. */
  approvers: string[];
  /** The head commit right now; a change is what un-parks a failed build. */
  headSha: string;
}

/**
 * What "waiting on me" means by default, as two searches: GitHub cannot OR
 * two qualifiers in one query, and being assigned and having your review
 * requested are different things — on spara-ai/spara-app two PRs were
 * requested without being assigned, and three assigned without being
 * requested. Both are PRs waiting on you, so both are asked for and the
 * answers are merged.
 *
 * Drafts are left out: a draft is not ready to be read. Approved PRs are
 * *not* — GitHub's `review:approved` means approved by anyone, so a PR with
 * one approval in and yours still requested would vanish. They come through
 * with `approved` set and the index hides them on request.
 */
export const DEFAULT_REVIEW_SEARCHES = [
  "is:open is:pr archived:false draft:false assignee:@me",
  "is:open is:pr archived:false draft:false review-requested:@me",
];

/** What "mine" means by default: every open PR you opened, drafts included. */
export const DEFAULT_AUTHORED_SEARCHES = ["is:open is:pr archived:false author:@me"];

/** One search to run, and which tab its hits belong on. */
export interface PrSearch {
  role: PrRole;
  /** A GitHub issue-search query, exactly as github.com/pulls would take it. */
  query: string;
}

/**
 * The qualifiers that tie a search to somebody or somewhere.
 *
 * A query with none of these returns every PR the token can see, in every
 * repo — which is how the watcher once handed six PRs from an unrelated
 * personal repo to the server. The fix used to be that every search named a
 * repo; that made the repo list the source of truth, which is a poor one.
 * The rule now is only that a search must be bounded by *something*: a repo,
 * an owner, or a person. `assignee:@me` is bounded. `is:open is:pr` is not.
 */
const BOUNDING = /(^|\s)-?(repo|user|org|owner|assignee|author|review-requested|reviewed-by|user-review-requested|team-review-requested|involves|mentions|commenter):/i;

export function isBounded(query: string): boolean {
  return BOUNDING.test(query);
}

/** The query a search should run, or a refusal saying why it will not. */
export function checkSearch(query: string): string {
  const clauses = query.trim();
  if (!clauses) throw new ConfigError("A search cannot be empty.");
  if (!isBounded(clauses)) {
    throw new ConfigError(
      `The search ${JSON.stringify(clauses)} names nobody and nowhere, so GitHub would answer it with every ` +
        "pull request the token can see. Add a repo:, user:, org:, assignee:, author: or review-requested: clause.",
    );
  }
  return clauses;
}

/**
 * The query out of whatever was pasted: a GitHub search URL — the address
 * bar of github.com/pulls, /issues or /search, where these are built — or
 * the query itself. Anything else comes back trimmed and is checked like
 * any other query.
 */
export function parseSearchInput(input: string): string {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (/(^|\.)github\.com$/i.test(url.hostname)) {
        const q = url.searchParams.get("q");
        if (q) return q.trim();
      }
    } catch {
      // Not a URL after all; treat it as a query.
    }
  }
  return text;
}

/** What one search hit looks like, once GraphQL has narrowed it to a pull request. */
interface SearchNode {
  number?: number;
  title?: string;
  url?: string;
  updatedAt?: string;
  isDraft?: boolean;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  headRefOid?: string;
  author?: { login: string } | null;
  repository?: { nameWithOwner: string };
  latestOpinionatedReviews?: { nodes: { state: string; author: { login: string } | null }[] };
}

interface SearchGraphResponse {
  data?: Record<string, { nodes: SearchNode[] } | undefined>;
  errors?: { message: string; type?: string }[];
}

/**
 * Every search in one request. GraphQL rather than the REST search because
 * the REST result knows nothing of reviews: whether a PR is approved, and by
 * whom, is only here, and it is what the index's "hide approved" needs. The
 * searches ride together as aliases, so a poll costs one call however many
 * questions it asks.
 */
function searchDocument(count: number): string {
  const params = Array.from({ length: count }, (_, i) => `$q${i}: String!`).join(", ");
  const fields = Array.from(
    { length: count },
    (_, i) => `  s${i}: search(query: $q${i}, type: ISSUE, first: ${PER_SEARCH}) { nodes { ...Pr } }`,
  ).join("\n");
  return `query(${params}) {\n${fields}\n}\nfragment Pr on PullRequest {\n  number title url updatedAt isDraft reviewDecision headRefOid\n  author { login }\n  repository { nameWithOwner }\n  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }\n}`;
}

/** GitHub's own ceiling for one search page, and so the most any one search reports. */
export const PER_SEARCH = 100;

/** A search hit into an `AssignedPr`, or null for a hit that is not a pull request we can name. */
function fromNode(node: SearchNode, role: PrRole): AssignedPr | null {
  if (typeof node.number !== "number" || !node.repository?.nameWithOwner) return null;
  const [owner, repo] = node.repository.nameWithOwner.split("/");
  if (!owner || !repo) return null;
  const latest = node.latestOpinionatedReviews?.nodes ?? [];
  const approvers = latest
    .filter((r) => r.state === "APPROVED" && r.author?.login)
    .map((r) => r.author!.login);
  const changesRequested = latest.some((r) => r.state === "CHANGES_REQUESTED");
  const approved =
    node.reviewDecision === "APPROVED" ||
    (node.reviewDecision !== "CHANGES_REQUESTED" && !changesRequested && approvers.length > 0);
  return {
    owner,
    repo,
    number: node.number,
    title: node.title ?? "",
    htmlUrl: node.url ?? `https://github.com/${owner}/${repo}/pull/${node.number}`,
    updatedAt: node.updatedAt ?? "",
    draft: node.isDraft ?? false,
    role,
    author: node.author?.login ?? "",
    approved,
    approvers,
    headSha: node.headRefOid ?? "",
  };
}

/**
 * The open PRs these searches find: what is waiting on your review, and
 * what you opened. A PR two searches both report comes back once, and one
 * that is both yours and assigned to you comes back as yours.
 *
 * This asks for *state*, not for events: every call reports the full set, so
 * a caller that has been asleep for a night catches up on one poll and needs
 * no cursor arithmetic to do it. Requires a token — `@me` has no meaning
 * without one.
 */
export async function searchPrs(
  searches: PrSearch[],
  options: { onNote?: ((message: string) => void) | undefined } = {},
): Promise<AssignedPr[]> {
  if (searches.length === 0) return [];
  const queries = searches.map((search) => checkSearch(search.query));
  const variables = Object.fromEntries(queries.map((query, i) => [`q${i}`, query]));
  const body = (await githubFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: searchDocument(searches.length), variables }),
    tokenRequired: "GITHUB_TOKEN is not set; it is needed to find your PRs.",
    failed: (status) => `GitHub search returned ${status}`,
  })) as SearchGraphResponse;
  if (body.errors?.length) {
    throw graphqlFailure(
      `GitHub search: ${body.errors.map((e) => e.message).join("; ")}`,
      body.errors,
    );
  }
  const byKey = new Map<string, AssignedPr>();
  // Review hits first and authored second, so a PR in both ends up as yours.
  const order = [...searches.keys()].sort((a, b) => Number(searches[a]!.role === "authored") - Number(searches[b]!.role === "authored"));
  for (const i of order) {
    const nodes = body.data?.[`s${i}`]?.nodes ?? [];
    if (nodes.length === PER_SEARCH) {
      options.onNote?.(`the search ${JSON.stringify(queries[i])} matched at least ${PER_SEARCH} PRs; only the first ${PER_SEARCH} are followed.`);
    }
    for (const node of nodes) {
      const pr = fromNode(node, searches[i]!.role);
      if (pr) byKey.set(`${pr.owner}/${pr.repo}#${pr.number}`, pr);
    }
  }
  return [...byKey.values()];
}
