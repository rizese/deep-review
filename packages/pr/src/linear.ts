import {
  BuildError,
  ConfigError,
  type DeepReviewError,
  InputError,
  TransientError,
} from "./errors.js";

const LINEAR_API = "https://api.linear.app/graphql";

/** `linear.app/<org>/issue/ENG-123/...` — the unambiguous form. */
const ISSUE_URL = /linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]{1,9})-(\d+)/gi;

/**
 * A bare `ENG-123` mention. The identifier may not continue to the left or
 * run into more of the same token to the right, but a trailing dash is fine:
 * branch names look like `adam/ENG-8-retry-budget`.
 */
const BARE_IDENTIFIER = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9})-(\d+)(?![A-Za-z0-9])/g;

/**
 * Prefixes that look like team keys but almost never are. Without this a PR
 * body mentioning UTF-8 or RFC-7231 costs a pointless API round trip.
 */
const NOT_TEAM_KEYS = new Set([
  "AES",
  "ANSI",
  "ARM",
  "CVE",
  "ECMA",
  "GPT",
  "HTTP",
  "IEEE",
  "IPV",
  "ISO",
  "JPEG",
  "MP",
  "PR",
  "RFC",
  "RGB",
  "SHA",
  "SOC",
  "TLS",
  "UTC",
  "UTF",
]);

export interface LinearIssue {
  identifier: string;
  title: string;
  /** The issue body as Markdown. Empty when the issue has no description. */
  description: string;
  url: string;
  state: string;
}

/** True when a Linear API key is available; without one, ticket lookup is skipped. */
export function isLinearConfigured(): boolean {
  return Boolean(process.env.LINEAR_API_KEY);
}

/**
 * Linear issue identifiers mentioned anywhere in the given text (PR body,
 * title, branch name). Deduplicated, uppercased, and ordered by first
 * appearance so the most prominent reference leads.
 */
export function extractIssueIdentifiers(...texts: string[]): string[] {
  const found = new Map<string, true>();
  for (const text of texts) {
    if (!text) continue;
    for (const pattern of [ISSUE_URL, BARE_IDENTIFIER]) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const team = match[1]!.toUpperCase();
        if (pattern === BARE_IDENTIFIER && NOT_TEAM_KEYS.has(team)) continue;
        found.set(`${team}-${Number(match[2]!)}`, true);
      }
    }
  }
  return [...found.keys()];
}

const ISSUE_QUERY = `query Issue($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
    nodes { identifier title description url state { name } }
  }
}`;

interface IssueQueryResponse {
  data?: {
    issues: {
      nodes: {
        identifier: string;
        title: string;
        description: string | null;
        url: string;
        state: { name: string };
      }[];
    };
  };
  errors?: { message: string }[];
}

/**
 * Linear's failures are classified like GitHub's: a rejected key is setup, a
 * rate limit or a dead server is worth retrying, and anything else is this
 * request. A 404 cannot happen here — GraphQL answers 200 for an issue that
 * does not exist, and `fetchIssue` reads that as "not a ticket".
 */
function httpFailure(message: string, status: number): DeepReviewError {
  if (status === 401 || status === 403) return new ConfigError(message);
  if (status === 429 || status >= 500) return new TransientError(message);
  return new InputError(message);
}

async function fetchIssue(identifier: string): Promise<LinearIssue | null> {
  const [team, number] = identifier.split("-");
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: process.env.LINEAR_API_KEY!,
    },
    body: JSON.stringify({
      query: ISSUE_QUERY,
      variables: { team, number: Number(number) },
    }),
  });
  if (!res.ok) {
    throw httpFailure(`Linear API returned ${res.status} for ${identifier}`, res.status);
  }
  const payload = (await res.json()) as IssueQueryResponse;
  if (payload.errors?.length) {
    const text = payload.errors.map((e) => e.message).join("; ");
    const message = `Linear API error for ${identifier}: ${text}`;
    if (/rate limit/i.test(text)) throw new TransientError(message);
    if (/authentication|not authenticated|invalid api key/i.test(text)) {
      throw new ConfigError(message);
    }
    throw new BuildError(message);
  }
  const node = payload.data?.issues.nodes[0];
  if (!node) return null;
  return {
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? "",
    url: node.url,
    state: node.state.name,
  };
}

/**
 * Look up each identifier in Linear, dropping the ones that do not resolve —
 * a mention like `API-2` may match the identifier shape without being a
 * ticket. Returns nothing when no API key is configured.
 */
export async function fetchLinearIssues(
  identifiers: string[],
): Promise<LinearIssue[]> {
  if (!isLinearConfigured() || identifiers.length === 0) return [];
  const results = await Promise.all(identifiers.map(fetchIssue));
  return results.filter((issue): issue is LinearIssue => issue !== null);
}
