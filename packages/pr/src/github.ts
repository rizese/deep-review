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
 * One call to GitHub. Owns the two names its token goes by, the headers
 * every endpoint wants, and the turn from a non-2xx response into an Error,
 * so the callers below are left holding only their own question.
 */
async function githubFetch(url: string, request: GithubRequest): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token && request.tokenRequired) throw new Error(request.tokenRequired);
  const res = await fetch(url, {
    ...(request.method !== undefined ? { method: request.method } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...request.headers,
    },
  });
  if (!res.ok) throw new Error(request.failed(res.status, Boolean(token)));
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
}

/**
 * The clauses that spell "waiting on me", as GitHub's search understands them.
 *
 * Assigned and open is not the same as needing review: a draft is not ready
 * to be read, so drafts are excluded. Approved PRs are *not* excluded here —
 * GitHub's `review:approved` means approved by anyone, so a PR with one
 * approval in and yours still requested would vanish from the list. They
 * come through with `approved` set instead, and the index hides them on
 * request.
 */
export const DEFAULT_REVIEW_QUERY = "is:open is:pr assignee:@me archived:false -is:draft";

/** The clauses that spell "mine": every open PR you opened, drafts included. */
export const DEFAULT_AUTHORED_QUERY = "is:open is:pr author:@me archived:false";

/** A `repo:` qualifier, negated or not, anywhere in a query string. */
const REPO_QUALIFIER = /(^|\s)-?repo:/i;

/** Does this query try to say which repo it is about? Only the caller may. */
export function namesRepo(query: string): boolean {
  return REPO_QUALIFIER.test(query);
}

export interface AssignedPrQuery {
  /**
   * The one `owner/repo` to search. Required, and not by accident: a search
   * with no repo returns every PR the token can see, in every repo, and the
   * watcher once handed six PRs from an unrelated personal repo to the
   * server that way. There is deliberately no way to ask for that here.
   */
  repo: string;
  /**
   * The filter clauses, without any `repo:` — that comes from `repo`, so a
   * query can never scope itself to a different repo than the one it is
   * filed under. Defaults to `DEFAULT_REVIEW_QUERY`.
   */
  query?: string | undefined;
}

/** One repo to watch: the review query and the authored query, both optional. */
export interface WatchedPrQuery extends AssignedPrQuery {
  /** Clauses for "my PRs" in this repo, without `repo:`. Defaults to `DEFAULT_AUTHORED_QUERY`. */
  authoredQuery?: string | undefined;
}

/**
 * The search string for one repo's PRs waiting on you.
 *
 * The `repo:` clause is appended here, from the option, rather than stored
 * in the query: the query then says *what kind* of PR and the repo says
 * *where*, and neither can contradict the other. A query that names a repo
 * itself is refused — two `repo:` qualifiers in one GitHub search widen it
 * to both repos, which is exactly the shape of leak this exists to prevent.
 */
export function assignedPrsQuery(options: AssignedPrQuery): string {
  return scopedQuery(options.repo, options.query ?? DEFAULT_REVIEW_QUERY);
}

/** The search string for one repo's PRs you opened; same rules as `assignedPrsQuery`. */
export function authoredPrsQuery(options: WatchedPrQuery): string {
  return scopedQuery(options.repo, options.authoredQuery ?? DEFAULT_AUTHORED_QUERY);
}

function scopedQuery(repo: string, query: string): string {
  const clauses = query.trim();
  if (namesRepo(clauses)) {
    throw new Error(
      `The query for ${repo} names a repo itself (${JSON.stringify(clauses)}); ` +
        "the repo comes from the entry, so leave repo: out of it.",
    );
  }
  return `${clauses} repo:${repo}`;
}

/** What one search hit looks like, once GraphQL has narrowed it to a pull request. */
interface SearchNode {
  number?: number;
  title?: string;
  url?: string;
  updatedAt?: string;
  isDraft?: boolean;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  author?: { login: string } | null;
  repository?: { nameWithOwner: string };
  latestOpinionatedReviews?: { nodes: { state: string; author: { login: string } | null }[] };
}

interface SearchGraphResponse {
  data?: { review?: { nodes: SearchNode[] }; authored?: { nodes: SearchNode[] } };
  errors?: { message: string }[];
}

/**
 * Both lists for one repo in one request. GraphQL rather than the REST
 * search because the REST result knows nothing of reviews: whether a PR is
 * approved, and by whom, is only here, and it is what the index's "hide
 * approved" needs. Two aliased searches ride in the one query, so a poll
 * costs one call per repo whatever it finds.
 */
const SEARCH_QUERY = `
query($review: String!, $authored: String!) {
  review: search(query: $review, type: ISSUE, first: 100) { nodes { ...Pr } }
  authored: search(query: $authored, type: ISSUE, first: 100) { nodes { ...Pr } }
}
fragment Pr on PullRequest {
  number title url updatedAt isDraft reviewDecision
  author { login }
  repository { nameWithOwner }
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
}`;

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
  };
}

/**
 * The open PRs in one repo that concern you: waiting on your review, and
 * opened by you. One PR can be in both — you opened it and assigned yourself
 * — and comes back once, as yours.
 *
 * This asks for *state*, not for events: every call reports the full set, so
 * a caller that has been asleep for a night catches up on one poll and needs
 * no cursor arithmetic to do it. Requires a token — `@me` has no meaning
 * without one. Requires a repo, too; see `AssignedPrQuery`.
 */
export async function listWatchedPrs(options: WatchedPrQuery): Promise<AssignedPr[]> {
  const variables = { review: assignedPrsQuery(options), authored: authoredPrsQuery(options) };
  const body = (await githubFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: SEARCH_QUERY, variables }),
    tokenRequired: "GITHUB_TOKEN is not set; it is needed to find your PRs.",
    failed: (status) => `GitHub search returned ${status}`,
  })) as SearchGraphResponse;
  if (body.errors?.length) {
    throw new Error(`GitHub search: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  const byKey = new Map<string, AssignedPr>();
  // Review hits first, authored second, so a PR in both ends up as yours.
  for (const [role, nodes] of [
    ["review", body.data?.review?.nodes ?? []],
    ["authored", body.data?.authored?.nodes ?? []],
  ] as const) {
    for (const node of nodes) {
      const pr = fromNode(node, role);
      if (pr) byKey.set(`${pr.owner}/${pr.repo}#${pr.number}`, pr);
    }
  }
  return [...byKey.values()];
}
