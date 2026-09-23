/**
 * What models a key can actually reach.
 *
 * The slicer's default model is a constant, which goes stale the moment a
 * provider moves on, and a retired id fails at the first build with a
 * message from the provider rather than anything this app can explain.
 * Asking the provider instead makes the default a placeholder rather than
 * a promise — and since the answer needs the key, a successful list is
 * also proof the key works, which nothing else checked.
 */

export type ProviderId = "openai" | "anthropic" | "xai";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** The settings field its key is stored in. */
  field: "openaiApiKey" | "anthropicApiKey" | "grokApiKey";
  /** Where the slicer reads that key from. */
  envVar: string;
}

export interface ModelChoice {
  id: string;
  /** What to show, when the provider gives a friendlier name than the id. */
  label: string;
}

interface Provider extends ProviderInfo {
  url: string;
  headers: (key: string) => Record<string, string>;
  /** Their answers differ in shape; each says how to read its own. */
  read: (body: unknown) => ModelChoice[];
}

/**
 * Model families that cannot do the slicer's job: it is an agent loop with
 * tools and a JSON schema, so anything that only embeds, transcribes,
 * speaks or draws would be offered only to fail. Matched on the id, which
 * is a guess about naming — but a wrong guess here hides a model, while no
 * guess at all offers a dozen that cannot work.
 */
const NOT_FOR_SLICING = /embed|moderation|tts|whisper|audio|transcrib|speech|image|dall-e|sora|realtime|search-preview|computer-use/i;

function keep(models: ModelChoice[]): ModelChoice[] {
  return models.filter((m) => !NOT_FOR_SLICING.test(m.id));
}

const PROVIDERS: Record<ProviderId, Provider> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    field: "openaiApiKey",
    envVar: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    read: (body) => {
      const data = (body as { data?: { id?: string; created?: number }[] }).data ?? [];
      return keep(
        [...data]
          .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
          .filter((m) => typeof m.id === "string")
          .map((m) => ({ id: m.id!, label: m.id! })),
      );
    },
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    field: "anthropicApiKey",
    envVar: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/models?limit=100",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    read: (body) => {
      // Already ordered newest first, and only ever chat models.
      const data = (body as { data?: { id?: string; display_name?: string }[] }).data ?? [];
      return keep(data.filter((m) => typeof m.id === "string").map((m) => ({ id: m.id!, label: m.display_name ?? m.id! })));
    },
  },
  xai: {
    id: "xai",
    label: "xAI",
    field: "grokApiKey",
    envVar: "XAI_API_KEY",
    url: "https://api.x.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    read: (body) => {
      const data = (body as { data?: { id?: string }[] }).data ?? [];
      return keep(data.filter((m) => typeof m.id === "string").map((m) => ({ id: m.id!, label: m.id! })));
    },
  },
};

export function providers(): ProviderInfo[] {
  return Object.values(PROVIDERS).map(({ id, label, field, envVar }) => ({ id, label, field, envVar }));
}

export function providerOf(id: string): ProviderInfo | null {
  return PROVIDERS[id as ProviderId] ?? null;
}

/** Which provider a model id would be sent to, by the slicer's own rule. */
export function providerForModel(modelId: string): ProviderId {
  if (modelId.startsWith("gpt-")) return "openai";
  if (modelId.startsWith("grok-")) return "xai";
  return "anthropic";
}

/** The models this key can reach, newest first, minus the ones that cannot slice. */
export async function listModels(id: ProviderId, key: string, fetchImpl: typeof fetch = fetch): Promise<ModelChoice[]> {
  const provider = PROVIDERS[id];
  const res = await fetchImpl(provider.url, { headers: { Accept: "application/json", ...provider.headers(key) } });
  if (res.status === 401 || res.status === 403) throw new Error(`${provider.label} did not accept that key`);
  if (!res.ok) throw new Error(`${provider.label} said ${res.status}`);
  const models = provider.read(await res.json());
  if (models.length === 0) throw new Error(`${provider.label} listed no models this key can use`);
  return models;
}
