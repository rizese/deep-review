import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildError, ConfigError, InputError, TransientError } from "./errors.js";
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

  it("reads a public PR with no token at all", async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const sent: (Record<string, string> | undefined)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => {
      sent.push(init.headers);
      return new Response(JSON.stringify(response));
    });
    await expect(fetchPrInfo({ owner: "acme", repo: "widgets", number: 1 })).resolves.toMatchObject({
      title: "t",
    });
    expect(sent[0]).not.toHaveProperty("Authorization");
  });
});

describe("a failed GitHub call", () => {
  const saved = { github: process.env.GITHUB_TOKEN, gh: process.env.GH_TOKEN };

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    if (saved.github !== undefined) process.env.GITHUB_TOKEN = saved.github;
    if (saved.gh !== undefined) process.env.GH_TOKEN = saved.gh;
  });

  /** The error `fetchPrInfo` rejects with when GitHub answers like this. */
  const failure = async (init: ResponseInit): Promise<unknown> => {
    vi.stubGlobal("fetch", async () => new Response("{}", init));
    return fetchPrInfo({ owner: "acme", repo: "widgets", number: 1 }).then(
      () => {
        throw new Error("expected the call to fail");
      },
      (error: unknown) => error,
    );
  };

  it("tells a repo it cannot see from a PR that is not there, by whether a token was sent", async () => {
    // The same 404 means two different things. Unauthenticated it is almost
    // always a private repo this machine has no key for — config, and no
    // amount of retrying helps. With a token in hand GitHub really is saying
    // the PR does not exist or is not visible: the input was wrong.
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const anonymous = await failure({ status: 404 });
    expect(anonymous).toBeInstanceOf(ConfigError);
    expect((anonymous as Error).message).toContain("(private repo? set GITHUB_TOKEN)");

    process.env.GITHUB_TOKEN = "t";
    const authenticated = await failure({ status: 404 });
    expect(authenticated).toBeInstanceOf(InputError);
    expect((authenticated as Error).message).toContain("GitHub API returned 404");
    expect((authenticated as Error).message).not.toContain("private repo");
  });

  it("reads a rejected token as config and a server fault as transient", async () => {
    process.env.GITHUB_TOKEN = "t";
    expect(await failure({ status: 401 })).toBeInstanceOf(ConfigError);
    expect(await failure({ status: 403 })).toBeInstanceOf(ConfigError);
    expect(await failure({ status: 503 })).toBeInstanceOf(TransientError);
    expect(await failure({ status: 422 })).toBeInstanceOf(InputError);
  });

  it("carries GitHub's own wait out of a rate limit", async () => {
    process.env.GITHUB_TOKEN = "t";
    const retryAfter = await failure({ status: 429, headers: { "Retry-After": "30" } });
    expect(retryAfter).toBeInstanceOf(TransientError);
    expect((retryAfter as TransientError).retryAfterMs).toBe(30_000);

    // The plain rate limit comes with a reset instant instead of a duration.
    const reset = Math.floor(Date.now() / 1000) + 60;
    const rateLimited = await failure({
      status: 429,
      headers: { "x-ratelimit-reset": String(reset) },
    });
    expect(rateLimited).toBeInstanceOf(TransientError);
    const ms = (rateLimited as TransientError).retryAfterMs ?? 0;
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThanOrEqual(60_000);

    // Nothing said: still transient, just with no instruction to follow.
    const bare = await failure({ status: 429 });
    expect((bare as TransientError).retryAfterMs).toBeUndefined();
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
    delete process.env.GH_TOKEN;
    await expect(listWatchedPrs({ repo: "acme/widgets" })).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(listWatchedPrs({ repo: "acme/widgets" })).rejects.toBeInstanceOf(ConfigError);
    process.env.GITHUB_TOKEN = "t";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: [{ message: "nope" }] })));
    await expect(listWatchedPrs({ repo: "acme/widgets" })).rejects.toThrow(/nope/);
    await expect(listWatchedPrs({ repo: "acme/widgets" })).rejects.toBeInstanceOf(BuildError);
  });

  it("reads the GraphQL errors it can act on: a rate limit waits, a bad token is setup", async () => {
    // GraphQL answers 200 whatever happened, so the status says nothing and
    // the messages are the only evidence of which failure this was.
    process.env.GITHUB_TOKEN = "t";
    const answering = (errors: { message: string; type?: string }[]) => {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors })));
      return listWatchedPrs({ repo: "acme/widgets" });
    };
    await expect(answering([{ message: "API rate limit exceeded" }])).rejects.toBeInstanceOf(
      TransientError,
    );
    await expect(
      answering([{ message: "too many requests", type: "RATE_LIMITED" }]),
    ).rejects.toBeInstanceOf(TransientError);
    await expect(answering([{ message: "Bad credentials" }])).rejects.toBeInstanceOf(ConfigError);
    await expect(
      answering([{ message: "Resource not accessible by integration" }]),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("refuses a query that names a repo as a setup mistake", () => {
    expect(() => assignedPrsQuery({ repo: "acme/widgets", query: "is:open repo:acme/other" })).toThrow(
      ConfigError,
    );
  });
});
