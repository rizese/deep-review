import { describe, expect, it, vi } from "vitest";
import { cliToken, identityOf, interpretPoll, needsRefresh, parseScopes, refreshGrant, startDeviceFlow, waitForToken } from "./githubAuth.js";

const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "Content-Type": "application/json", ...init.headers } });

describe("interpretPoll", () => {
  it("takes the token when it arrives", () => {
    const outcome = interpretPoll({ access_token: "gho_1" }, 5000);
    expect(outcome).toMatchObject({ kind: "token", grant: { token: "gho_1" } });
  });

  it("reads an expiring grant, and a non-expiring one, from the same answer shape", () => {
    // An app registered with "Expire user access tokens" sends an expiry
    // and a refresh token; one registered without sends neither.
    const expiring = interpretPoll(
      { access_token: "gho_1", expires_in: 28_800, refresh_token: "ghr_1", refresh_token_expires_in: 15_552_000 },
      5000,
    );
    expect(expiring).toMatchObject({ kind: "token" });
    if (expiring.kind !== "token") throw new Error("expected a token");
    expect(expiring.grant.refreshToken).toBe("ghr_1");
    expect(expiring.grant.expiresAt).toBeGreaterThan(Date.now());
    expect(expiring.grant.refreshExpiresAt).toBeGreaterThan(expiring.grant.expiresAt!);

    const forever = interpretPoll({ access_token: "gho_2" }, 5000);
    if (forever.kind !== "token") throw new Error("expected a token");
    expect(forever.grant.expiresAt).toBeNull();
    expect(forever.grant.refreshToken).toBe("");
  });

  it("keeps waiting while the reader has not answered", () => {
    expect(interpretPoll({ error: "authorization_pending" }, 5000)).toEqual({ kind: "pending", waitMs: 5000 });
  });

  it("backs off five seconds when GitHub says slow down", () => {
    expect(interpretPoll({ error: "slow_down" }, 5000)).toEqual({ kind: "pending", waitMs: 10_000 });
  });

  it("gives up, in words, on an expired code or a refusal", () => {
    expect(interpretPoll({ error: "expired_token" }, 5000)).toEqual({ kind: "failed", why: "the code expired; start again" });
    expect(interpretPoll({ error: "access_denied" }, 5000)).toEqual({ kind: "failed", why: "you turned the request down" });
    expect(interpretPoll({ error: "unsupported_grant_type", error_description: "nope" }, 5000)).toEqual({ kind: "failed", why: "nope" });
  });
});

describe("startDeviceFlow", () => {
  it("asks for a code and reports what to show the reader", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ device_code: "dev", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }),
    );
    const start = await startDeviceFlow("client", fetchImpl as never);
    expect(start.prompt.userCode).toBe("ABCD-1234");
    expect(start.deviceCode).toBe("dev");
    expect(start.intervalMs).toBe(5000);
    expect(start.prompt.expiresAt).toBeGreaterThan(Date.now());
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({ client_id: "client", scope: "repo read:org" });
  });

  it("never polls below GitHub's five-second floor", async () => {
    const fetchImpl = vi.fn(async () => json({ device_code: "d", user_code: "u", verification_uri: "v", interval: 1 }));
    expect((await startDeviceFlow("c", fetchImpl as never)).intervalMs).toBe(5000);
  });

  it("says what GitHub complained about", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "unauthorized_client", error_description: "device flow is off" }, { status: 400 }));
    await expect(startDeviceFlow("c", fetchImpl as never)).rejects.toThrow("device flow is off");
  });
});

describe("waitForToken", () => {
  it("polls until the reader approves", async () => {
    const answers = [json({ error: "authorization_pending" }), json({ error: "slow_down" }), json({ access_token: "gho_2" })];
    const fetchImpl = vi.fn(async () => answers.shift()!);
    const waits: number[] = [];
    const token = await waitForToken(
      "c",
      { prompt: { userCode: "u", verificationUri: "v", expiresAt: Date.now() + 60_000 }, deviceCode: "d", intervalMs: 5000 },
      { fetchImpl: fetchImpl as never, sleep: async (ms) => void waits.push(ms) },
    );
    expect(token.token).toBe("gho_2");
    expect(waits).toEqual([5000, 5000, 10_000]);
  });

  it("stops when the reader calls it off", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForToken(
        "c",
        { prompt: { userCode: "u", verificationUri: "v", expiresAt: Date.now() + 60_000 }, deviceCode: "d", intervalMs: 5000 },
        { fetchImpl: (async () => json({})) as never, sleep: async () => {}, signal: controller.signal },
      ),
    ).rejects.toThrow("called off");
  });

  it("stops when the code has expired", async () => {
    await expect(
      waitForToken(
        "c",
        { prompt: { userCode: "u", verificationUri: "v", expiresAt: Date.now() - 1 }, deviceCode: "d", intervalMs: 1 },
        { fetchImpl: (async () => json({})) as never, sleep: async () => {} },
      ),
    ).rejects.toThrow("expired");
  });
});

describe("refreshGrant", () => {
  it("trades a spent token for the next one, and keeps the next refresh token", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ access_token: "gho_new", expires_in: 28_800, refresh_token: "ghr_new", refresh_token_expires_in: 15_552_000 }),
    );
    const grant = await refreshGrant("client", "ghr_old", fetchImpl as never);
    expect(grant.token).toBe("gho_new");
    expect(grant.refreshToken).toBe("ghr_new");
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: "client",
      grant_type: "refresh_token",
      refresh_token: "ghr_old",
    });
  });

  it("says why when GitHub will not trade", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "bad_refresh_token", error_description: "expired" }, { status: 400 }));
    await expect(refreshGrant("c", "ghr_old", fetchImpl as never)).rejects.toThrow("expired");
  });
});

describe("needsRefresh", () => {
  it("is never true for a token that does not expire", () => {
    expect(needsRefresh(null)).toBe(false);
  });

  it("trades a token in a minute before it stops working, not after", () => {
    const now = 1_000_000;
    expect(needsRefresh(now + 5 * 60_000, now)).toBe(false);
    expect(needsRefresh(now + 30_000, now)).toBe(true);
    expect(needsRefresh(now - 1, now)).toBe(true);
  });
});

describe("identityOf", () => {
  it("says who the token belongs to and what it may do", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ login: "rizese", name: "Ricky", avatar_url: "https://avatars/1" }, { headers: { "x-oauth-scopes": "repo, read:org" } }),
    );
    expect(await identityOf("t", fetchImpl as never)).toEqual({
      login: "rizese",
      name: "Ricky",
      avatarUrl: "https://avatars/1",
      scopes: ["repo", "read:org"],
    });
  });

  it("calls a rejected token what it is", async () => {
    const fetchImpl = vi.fn(async () => json({ message: "Bad credentials" }, { status: 401 }));
    await expect(identityOf("t", fetchImpl as never)).rejects.toThrow("does not accept this token");
  });

  it("reads no scopes at all without complaint", () => {
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
  });
});

describe("cliToken", () => {
  it("takes the token gh is signed in with", async () => {
    const exec = vi.fn(async () => ({ stdout: "gho_cli\n", stderr: "" }));
    expect(await cliToken(exec as never)).toBe("gho_cli");
  });

  it("is quiet when gh is missing or signed out", async () => {
    expect(await cliToken((async () => { throw new Error("not found"); }) as never)).toBeNull();
    expect(await cliToken((async () => ({ stdout: "\n", stderr: "" })) as never)).toBeNull();
  });
});
