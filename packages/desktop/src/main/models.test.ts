import { describe, expect, it, vi } from "vitest";
import { listModels, providerForModel, providerOf, providers } from "./models.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("listModels", () => {
  it("reads OpenAI's list newest first and leaves out what cannot slice", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        data: [
          { id: "text-embedding-3-large", created: 900 },
          { id: "gpt-5.6-sol", created: 800 },
          { id: "dall-e-3", created: 700 },
          { id: "gpt-6-nova", created: 1000 },
          { id: "whisper-1", created: 600 },
        ],
      }),
    );
    expect((await listModels("openai", "sk-test", fetchImpl as never)).map((m) => m.id)).toEqual(["gpt-6-nova", "gpt-5.6-sol"]);
  });

  it("sends each provider the header it wants", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return json({ data: [{ id: "m" }] });
    });
    await listModels("openai", "sk-a", fetchImpl as never);
    await listModels("anthropic", "sk-b", fetchImpl as never);
    await listModels("xai", "sk-c", fetchImpl as never);
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer sk-a");
    // Anthropic takes a key header and a dated version, not a bearer token.
    expect(seen[1]!.headers["x-api-key"]).toBe("sk-b");
    expect(seen[1]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[2]!.url).toContain("api.x.ai");
  });

  it("prefers Anthropic's display name and keeps its order", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ data: [{ id: "claude-x-1", display_name: "Claude X" }, { id: "claude-w-1" }] }),
    );
    expect(await listModels("anthropic", "k", fetchImpl as never)).toEqual([
      { id: "claude-x-1", label: "Claude X" },
      { id: "claude-w-1", label: "claude-w-1" },
    ]);
  });

  it("calls a rejected key what it is, rather than passing on a status", async () => {
    await expect(listModels("openai", "bad", (async () => json({}, 401)) as never)).rejects.toThrow(/did not accept that key/);
    await expect(listModels("openai", "k", (async () => json({}, 500)) as never)).rejects.toThrow(/said 500/);
  });

  it("says so when everything the key can reach was filtered out", async () => {
    const fetchImpl = vi.fn(async () => json({ data: [{ id: "text-embedding-3-small" }] }));
    await expect(listModels("openai", "k", fetchImpl as never)).rejects.toThrow(/listed no models/);
  });
});

describe("the provider table", () => {
  it("routes a model id the way the slicer does", () => {
    expect(providerForModel("gpt-5.6-sol")).toBe("openai");
    expect(providerForModel("grok-4")).toBe("xai");
    expect(providerForModel("claude-sonnet-4.5")).toBe("anthropic");
  });

  it("names the settings field and environment variable for each", () => {
    expect(providers().map((p) => [p.id, p.field, p.envVar])).toEqual([
      ["openai", "openaiApiKey", "OPENAI_API_KEY"],
      ["anthropic", "anthropicApiKey", "ANTHROPIC_API_KEY"],
      ["xai", "grokApiKey", "XAI_API_KEY"],
    ]);
    expect(providerOf("nope")).toBeNull();
  });
});
