import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildError, ConfigError, InputError, TransientError } from "./errors.js";
import {
  checkSearch,
  DEFAULT_AUTHORED_SEARCHES,
  DEFAULT_REVIEW_SEARCHES,
  fetchPrInfo,
  isBounded,
  parseSearchInput,
  PER_SEARCH,
  searchPrs,
  type PrSearch,
} from "./github.js";

describe("the default searches", () => {
  it("ask for open PRs assigned to you and for ones whose review you were asked for", () => {
    expect(DEFAULT_REVIEW_SEARCHES).toHaveLength(2);
    expect(DEFAULT_REVIEW_SEARCHES[0]).toContain("assignee:@me");
    expect(DEFAULT_REVIEW_SEARCHES[1]).toContain("review-requested:@me");
    for (const q of DEFAULT_REVIEW_SEARCHES) {
      expect(q).toContain("is:open");
      expect(q).toContain("is:pr");
      // A draft is not ready to be read.
      expect(q).toContain("draft:false");
    }
  });

  it("do not exclude approved PRs, since GitHub's approval is anyone's", () => {
    // `review:approved` is satisfied by *any* approval, so a PR with one
    // review in and yours still asked for would vanish from the list.
    // Approved PRs come through and the index hides them on request instead.
    for (const q of DEFAULT_REVIEW_SEARCHES) expect(q).not.toContain("review:approved");
  });

  it("ask for your own open PRs separately, drafts included", () => {
    expect(DEFAULT_AUTHORED_SEARCHES).toEqual(["is:open is:pr archived:false author:@me"]);
    expect(DEFAULT_AUTHORED_SEARCHES[0]).not.toContain("draft:false");
  });

  it("name nowhere in particular: the search is the source of truth, not a repo list", () => {
    for (const q of [...DEFAULT_REVIEW_SEARCHES, ...DEFAULT_AUTHORED_SEARCHES]) {
      expect(q).not.toContain("repo:");
      expect(isBounded(q)).toBe(true);
    }
  });
});

describe("checkSearch", () => {
  it("takes a search bound to a person, an owner or a repo", () => {
    for (const q of [
      "is:open is:pr assignee:@me",
      "is:open is:pr user:spara-ai draft:false assignee:rizese",
      "is:open is:pr repo:acme/widgets",
      "is:open is:pr org:acme",
      "is:open is:pr review-requested:@me",
      "is:open is:pr involves:rizese",
    ]) {
      expect(checkSearch(q)).toBe(q);
    }
  });

  it("refuses one that would return every PR the token can see", () => {
    // This is how the watcher once handed over six PRs from a personal repo.
    expect(() => checkSearch("is:open is:pr")).toThrow(/names nobody and nowhere/);
    expect(() => checkSearch("  ")).toThrow(/cannot be empty/);
    expect(() => checkSearch("is:open is:pr")).toThrow(ConfigError);
  });

  it("does not mistake a word ending in a qualifier's name for the qualifier", () => {
    expect(isBounded("is:open label:monorepo:fix")).toBe(false);
    expect(isBounded("is:open REPO:x")).toBe(true);
    expect(isBounded("is:open -user:dependabot")).toBe(true);
  });

  it("trims what it is given", () => {
    expect(checkSearch("  is:open assignee:@me  ")).toBe("is:open assignee:@me");
  });
});

describe("parseSearchInput", () => {
  it("takes the query out of a GitHub search URL, which is where these are built", () => {
    expect(
      parseSearchInput(
        "https://github.com/pulls/search?q=is%3Aopen+is%3Apr+archived%3Afalse+user%3Aspara-ai+draft%3Afalse+assignee%3Arizese+sort%3Aupdated-desc",
      ),
    ).toBe("is:open is:pr archived:false user:spara-ai draft:false assignee:rizese sort:updated-desc");
    expect(parseSearchInput("https://github.com/issues?q=is%3Aopen+assignee%3A%40me")).toBe("is:open assignee:@me");
  });

  it("leaves a query alone", () => {
    expect(parseSearchInput("  is:open is:pr assignee:@me ")).toBe("is:open is:pr assignee:@me");
  });

  it("does not take a q from somewhere that is not GitHub, or from a URL without one", () => {
    expect(parseSearchInput("https://example.com/?q=is:open")).toBe("https://example.com/?q=is:open");
    expect(parseSearchInput("https://github.com/pulls")).toBe("https://github.com/pulls");
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

describe("searchPrs", () => {
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

  const SEARCHES: PrSearch[] = [
    { role: "review", query: "is:open is:pr assignee:@me" },
    { role: "authored", query: "is:open is:pr author:@me" },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
  });

  it("asks every search in one request and reads each PR's role and approval", async () => {
    process.env.GITHUB_TOKEN = "t";
    const calls: { url: string; body: { query: string; variables: Record<string, string> } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          data: {
            s0: {
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
            s1: { nodes: [node(2, { author: { login: "me" }, isDraft: true }), node(3, { author: { login: "me" } })] },
          },
        }),
      );
    });
    const prs = await searchPrs(SEARCHES);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/graphql");
    expect(calls[0]!.body.variables).toEqual({ q0: "is:open is:pr assignee:@me", q1: "is:open is:pr author:@me" });
    expect(calls[0]!.body.query).toContain("s0: search(query: $q0");
    expect(calls[0]!.body.query).toContain("s1: search(query: $q1");
    expect(prs.map((pr) => [pr.number, pr.role, pr.approved, pr.approvers, pr.author, pr.draft])).toEqual([
      [1, "review", true, ["alex"], "someone", false],
      // In both lists: yours, once.
      [2, "authored", false, [], "me", true],
      [3, "authored", false, [], "me", false],
    ]);
  });

  it("merges two review searches, reporting a PR both find only once", async () => {
    process.env.GITHUB_TOKEN = "t";
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ data: { s0: { nodes: [node(1), node(2)] }, s1: { nodes: [node(2), node(5)] } } })),
    );
    const prs = await searchPrs([
      { role: "review", query: "is:open assignee:@me" },
      { role: "review", query: "is:open review-requested:@me" },
    ]);
    expect(prs.map((pr) => pr.number)).toEqual([1, 2, 5]);
  });

  it("says nothing to GitHub when there is nothing to ask", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    expect(await searchPrs([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a search that names nobody rather than asking it", async () => {
    process.env.GITHUB_TOKEN = "t";
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    await expect(searchPrs([{ role: "review", query: "is:open is:pr" }])).rejects.toBeInstanceOf(ConfigError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says so when a search matched more than one page", async () => {
    process.env.GITHUB_TOKEN = "t";
    const nodes = Array.from({ length: PER_SEARCH }, (_, i) => node(i + 1));
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: { s0: { nodes } } })));
    const notes: string[] = [];
    await searchPrs([{ role: "review", query: "is:open assignee:@me" }], { onNote: (m) => notes.push(m) });
    expect(notes.join(" ")).toContain("at least 100");
  });

  it("counts an approval where the branch requires no review, unless changes were requested", async () => {
    process.env.GITHUB_TOKEN = "t";
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          data: {
            s0: {
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
            s1: { nodes: [] },
          },
        }),
      ),
    );
    const prs = await searchPrs(SEARCHES);
    expect(prs.map((pr) => [pr.number, pr.approved, pr.approvers])).toEqual([
      [1, true, ["alex"]],
      [2, false, ["alex"]],
    ]);
  });

  it("refuses to search without a token, and surfaces GraphQL errors", async () => {
    delete process.env.GH_TOKEN;
    await expect(searchPrs(SEARCHES)).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(searchPrs(SEARCHES)).rejects.toBeInstanceOf(ConfigError);
    process.env.GITHUB_TOKEN = "t";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: [{ message: "nope" }] })));
    await expect(searchPrs(SEARCHES)).rejects.toThrow(/nope/);
    await expect(searchPrs(SEARCHES)).rejects.toBeInstanceOf(BuildError);
  });

  it("reads the GraphQL errors it can act on: a rate limit waits, a bad token is setup", async () => {
    // GraphQL answers 200 whatever happened, so the status says nothing and
    // the messages are the only evidence of which failure this was.
    process.env.GITHUB_TOKEN = "t";
    const answering = (errors: { message: string; type?: string }[]) => {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors })));
      return searchPrs(SEARCHES);
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
});
