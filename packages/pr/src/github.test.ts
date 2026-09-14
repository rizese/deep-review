import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assignedPrsQuery,
  authoredPrsQuery,
  DEFAULT_AUTHORED_QUERY,
  DEFAULT_REVIEW_QUERY,
  fetchPrInfo,
  listWatchedPrs,
  namesRepo,
} from "./github.js";

describe("assignedPrsQuery", () => {
  const acme = { repo: "acme/widgets" };

  it("asks for open PRs assigned to the token's owner", () => {
    const q = assignedPrsQuery(acme);
    expect(q).toContain("is:open");
    expect(q).toContain("is:pr");
    expect(q).toContain("assignee:@me");
  });

  it("excludes drafts, which are not ready to be read", () => {
    expect(assignedPrsQuery(acme)).toContain("-is:draft");
  });

  it("does not exclude approved PRs, since GitHub's approval is anyone's", () => {
    // `-review:approved` once lived here to skip PRs you had signed off on.
    // But GitHub's `review:approved` is satisfied by *any* approval, so a PR
    // with one review in and yours still asked for vanished from the list.
    // Approved PRs come through and the index hides them on request instead.
    expect(assignedPrsQuery(acme)).not.toContain("review:approved");
  });

  it("asks for your own open PRs separately, drafts included", () => {
    const q = authoredPrsQuery(acme);
    expect(q).toBe(`${DEFAULT_AUTHORED_QUERY} repo:acme/widgets`);
    expect(q).toContain("author:@me");
    expect(q).not.toContain("-is:draft");
    expect(authoredPrsQuery({ repo: "acme/widgets", authoredQuery: "is:open is:pr author:@me label:x" })).toBe(
      "is:open is:pr author:@me label:x repo:acme/widgets",
    );
    expect(() => authoredPrsQuery({ repo: "acme/widgets", authoredQuery: "is:open repo:acme/other" })).toThrow(
      /names a repo/,
    );
  });

  it("always scopes to the repo it was given", () => {
    // There is no unscoped form. A search with no repo: returns every PR
    // the token can see, and once handed the watcher six PRs from a repo
    // nobody meant to watch; the option is required so that cannot recur.
    expect(assignedPrsQuery(acme)).toContain("repo:acme/widgets");
    expect(assignedPrsQuery(acme)).toBe(`${DEFAULT_REVIEW_QUERY} repo:acme/widgets`);
  });

  it("takes a repo's own clauses in place of the default ones", () => {
    const q = assignedPrsQuery({ repo: "acme/widgets", query: "is:open is:pr review-requested:@me" });
    expect(q).toBe("is:open is:pr review-requested:@me repo:acme/widgets");
    expect(q).not.toContain("assignee:@me");
  });

  it("appends the repo from the option, never from the clauses", () => {
    // Two repo: qualifiers in one GitHub search widen it to both repos, so a
    // configured query that named a repo could quietly watch a second one.
    // The repo is the entry's business; a query that claims one is refused.
    expect(() => assignedPrsQuery({ repo: "acme/widgets", query: "is:open repo:acme/other" })).toThrow(
      /names a repo/,
    );
    expect(() => assignedPrsQuery({ repo: "acme/widgets", query: "is:open -repo:acme/other" })).toThrow();
  });

  it("does not mistake a word ending in repo: for the qualifier", () => {
    expect(namesRepo("is:open label:monorepo:fix")).toBe(false);
    expect(namesRepo("repo:x")).toBe(true);
    expect(namesRepo("is:open REPO:x")).toBe(true);
  });
});

describe("fetchPrInfo", () => {
  const response = {
    title: "t",
    body: null,
    html_url: "https://github.com/acme/widgets/pull/1",
    state: "closed",
    merged: true,
    user: { login: "a" },
    base: { ref: "main", sha: "b", repo: { clone_url: "c" } },
    head: { ref: "f", sha: "h" },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports whether the PR is still open, and whether closing it meant merging", async () => {
    // The watcher removes a PR from the server once it is merged or closed,
    // and this is the only place it can learn that: the search it polls asks
    // for open PRs only, so a merged one has simply vanished from it — as has
    // an approved one, which must stay. The pulls endpoint tells them apart.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response)));
    const info = await fetchPrInfo({ owner: "acme", repo: "widgets", number: 1 });
    expect(info.state).toBe("closed");
    expect(info.merged).toBe(true);
  });
});

describe("listWatchedPrs", () => {
  const node = (number: number, extra: Record<string, unknown> = {}) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    updatedAt: "2026-09-01T10:00:00Z",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    author: { login: "someone" },
    repository: { nameWithOwner: "acme/widgets" },
    latestOpinionatedReviews: { nodes: [] },
    ...extra,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
  });

  it("asks both questions in one request and reads each PR's role and approval", async () => {
    process.env.GITHUB_TOKEN = "t";
    const calls: { url: string; body: { query: string; variables: Record<string, string> } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          data: {
            review: {
              nodes: [
                node(1, {
                  reviewDecision: "APPROVED",
                  latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { login: "alex" } }] },
                }),
                node(2),
                // A hit that is not a pull request comes back as an empty object.
                {},
              ],
            },
            authored: { nodes: [node(2, { author: { login: "me" }, isDraft: true }), node(3, { author: { login: "me" } })] },
          },
        }),
      );
    });
    const prs = await listWatchedPrs({ repo: "acme/widgets" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/graphql");
    expect(calls[0]!.body.variables).toEqual({
      review: `${DEFAULT_REVIEW_QUERY} repo:acme/widgets`,
      authored: `${DEFAULT_AUTHORED_QUERY} repo:acme/widgets`,
    });
    expect(prs.map((pr) => [pr.number, pr.role, pr.approved, pr.approvers, pr.author, pr.draft])).toEqual([
      [1, "review", true, ["alex"], "someone", false],
      // In both lists: yours, once.
      [2, "authored", false, [], "me", true],
      [3, "authored", false, [], "me", false],
    ]);
  });

  it("counts an approval where the branch requires no review, unless changes were requested", async () => {
    process.env.GITHUB_TOKEN = "t";
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          data: {
            review: {
              nodes: [
                node(1, {
                  reviewDecision: null,
                  latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { login: "alex" } }] },
                }),
                node(2, {
                  reviewDecision: null,
                  latestOpinionatedReviews: {
                    nodes: [
                      { state: "APPROVED", author: { login: "alex" } },
                      { state: "CHANGES_REQUESTED", author: { login: "sam" } },
                    ],
                  },
                }),
              ],
            },
            authored: { nodes: [] },
          },
        }),
      ),
    );
    const prs = await listWatchedPrs({ repo: "acme/widgets" });
    expect(prs.map((pr) => [pr.number, pr.approved, pr.approvers])).toEqual([
      [1, true, ["alex"]],
      [2, false, ["alex"]],
    ]);
  });

  it("refuses to search without a token, and surfaces GraphQL errors", async () => {
    await expect(listWatchedPrs({ repo: "acme/widgets" })).rejects.toThrow(/GITHUB_TOKEN/);
    process.env.GITHUB_TOKEN = "t";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: [{ message: "nope" }] })));
    await expect(listWatchedPrs({ repo: "acme/widgets" })).rejects.toThrow(/nope/);
  });
});
