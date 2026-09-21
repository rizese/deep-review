/**
 * Signing in to GitHub from the app rather than pasting a token.
 *
 * Two ways in. The Device Flow is the one built for a desktop app: the app
 * asks GitHub for a short code, the reader types it into github.com in
 * their browser, and the app — polling all the while — is handed a token.
 * It needs an OAuth App's client id, which is public, so there is no
 * secret in the bundle and no redirect to catch. The other way is the
 * GitHub CLI: if `gh` is signed in on this machine its token is already
 * good, and taking it costs one click.
 *
 * The network calls are injectable so the parts that decide can be tested
 * without reaching GitHub.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

/** What the watcher needs: its own PRs, the ones waiting on it, and private repos. */
export const SCOPES = "repo read:org";

export type Fetch = typeof globalThis.fetch;

export interface DevicePrompt {
  /** The code the reader types into GitHub. */
  userCode: string;
  /** Where they type it. */
  verificationUri: string;
  /** When the code stops working. */
  expiresAt: number;
}

export interface GithubIdentity {
  login: string;
  name: string | null;
  avatarUrl: string;
  /** What the token may do, as GitHub reports it; empty when it does not say. */
  scopes: string[];
}

interface DeviceCodeBody {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface TokenBody {
  access_token?: string;
  /** Seconds until the access token stops working; absent when it never does. */
  expires_in?: number;
  /** Present only when the app was registered with expiring user tokens. */
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * What a sign-in yields. An OAuth App registered with "Expire user access
 * tokens" hands over a token good for eight hours and a refresh token good
 * for six months; one registered without it hands over a token that does
 * not expire, and `expiresAt` is then null. Both are handled, so the
 * checkbox on the registration form is not a decision anyone has to get
 * right.
 */
export interface TokenGrant {
  token: string;
  /** When the token stops working, or null when it does not. */
  expiresAt: number | null;
  /** What to trade for the next token; empty when the token never expires. */
  refreshToken: string;
  /** When the refresh token itself stops working, or null. */
  refreshExpiresAt: number | null;
}

function grantOf(body: TokenBody, now = Date.now()): TokenGrant {
  return {
    token: body.access_token ?? "",
    expiresAt: body.expires_in ? now + body.expires_in * 1000 : null,
    refreshToken: body.refresh_token ?? "",
    refreshExpiresAt: body.refresh_token_expires_in ? now + body.refresh_token_expires_in * 1000 : null,
  };
}

/** A started device flow: what to show the reader, and what to poll with. */
export interface DeviceStart {
  prompt: DevicePrompt;
  deviceCode: string;
  intervalMs: number;
}

function complain(body: { error?: string; error_description?: string }, fallback: string): Error {
  return new Error(body.error_description ?? body.error ?? fallback);
}

export async function startDeviceFlow(clientId: string, fetchImpl: Fetch = fetch): Promise<DeviceStart> {
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: SCOPES }),
  });
  const body = (await res.json()) as DeviceCodeBody;
  if (!res.ok || !body.device_code || !body.user_code || !body.verification_uri) {
    throw complain(body, `GitHub said ${res.status}`);
  }
  return {
    prompt: {
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresAt: Date.now() + (body.expires_in ?? 900) * 1000,
    },
    deviceCode: body.device_code,
    // GitHub's floor is 5s; polling faster earns a slow_down.
    intervalMs: Math.max(5, body.interval ?? 5) * 1000,
  };
}

export type PollOutcome =
  | { kind: "token"; grant: TokenGrant }
  | { kind: "pending"; waitMs: number }
  | { kind: "failed"; why: string };

/**
 * What one poll of the token endpoint means. GitHub answers 200 with an
 * `error` field for the ordinary waiting states, so the status alone does
 * not say; this is the whole of the decision, and it is pure.
 */
export function interpretPoll(body: TokenBody, waitMs: number): PollOutcome {
  if (body.access_token) return { kind: "token", grant: grantOf(body) };
  switch (body.error) {
    case "authorization_pending":
      return { kind: "pending", waitMs };
    case "slow_down":
      // GitHub asks for 5 more seconds between polls, and means it.
      return { kind: "pending", waitMs: waitMs + 5000 };
    case "expired_token":
      return { kind: "failed", why: "the code expired; start again" };
    case "access_denied":
      return { kind: "failed", why: "you turned the request down" };
    default:
      return { kind: "failed", why: body.error_description ?? body.error ?? "GitHub would not say why" };
  }
}

export interface WaitOptions {
  fetchImpl?: Fetch;
  /** Waits between polls; the default sleeps. Tests pass their own. */
  sleep?: (ms: number) => Promise<void>;
  /** Stops the wait: the reader cancelled, or the app is quitting. */
  signal?: AbortSignal;
}

const nap = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until GitHub hands over a token, the code expires, or the wait is called off. */
export async function waitForToken(clientId: string, start: DeviceStart, options: WaitOptions = {}): Promise<TokenGrant> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? nap;
  let waitMs = start.intervalMs;
  for (;;) {
    if (options.signal?.aborted) throw new Error("sign-in was called off");
    await sleep(waitMs);
    if (options.signal?.aborted) throw new Error("sign-in was called off");
    if (Date.now() > start.prompt.expiresAt) throw new Error("the code expired; start again");
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: start.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const outcome = interpretPoll((await res.json()) as TokenBody, waitMs);
    if (outcome.kind === "token") return outcome.grant;
    if (outcome.kind === "failed") throw new Error(outcome.why);
    waitMs = outcome.waitMs;
  }
}

/**
 * Trade a refresh token for a fresh one. Only apps registered with
 * expiring tokens ever need this, and the answer carries its own next
 * refresh token: the old one is spent.
 */
export async function refreshGrant(clientId: string, refreshToken: string, fetchImpl: Fetch = fetch): Promise<TokenGrant> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const body = (await res.json()) as TokenBody;
  if (!body.access_token) throw complain(body, `GitHub said ${res.status}`);
  return grantOf(body);
}

/**
 * Whether a grant should be traded in now. A minute of margin, so a token
 * that would expire mid-poll is replaced before the poll rather than
 * during it.
 */
export function needsRefresh(expiresAt: number | null, now = Date.now()): boolean {
  return expiresAt !== null && now > expiresAt - 60_000;
}

/** Scopes as GitHub lists them on a response header: "repo, read:org". */
export function parseScopes(header: string | null): string[] {
  return (header ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Who a token belongs to, which is also how the app knows it still works. */
export async function identityOf(token: string, fetchImpl: Fetch = fetch): Promise<GithubIdentity> {
  const res = await fetchImpl(USER_URL, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "deep-review" },
  });
  if (res.status === 401) throw new Error("GitHub does not accept this token any more");
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  const body = (await res.json()) as { login?: string; name?: string | null; avatar_url?: string };
  if (!body.login) throw new Error("GitHub did not say who this is");
  return {
    login: body.login,
    name: body.name ?? null,
    avatarUrl: body.avatar_url ?? "",
    scopes: parseScopes(res.headers.get("x-oauth-scopes")),
  };
}

/** The token the GitHub CLI is signed in with, or null if there is none to take. */
export async function cliToken(exec: typeof run = run): Promise<string | null> {
  try {
    const { stdout } = await exec("gh", ["auth", "token"], { timeout: 5000 });
    const token = stdout.trim();
    return token || null;
  } catch {
    // `gh` is not installed, or nobody is signed in to it.
    return null;
  }
}
