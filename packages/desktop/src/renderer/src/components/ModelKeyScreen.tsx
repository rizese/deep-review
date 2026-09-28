import { useState, type FormEvent, type JSX } from "react";
import type { ModelChoice, ModelStatus, ProviderInfo } from "../../../types/electronAPI.js";
import { Button } from "./Button.js";
import { FirstRun, type Note } from "./FirstRun.js";
import { Segmented } from "./Segmented.js";
import styles from "./ModelKeyScreen.module.css";

/** What each provider's keys look like, so the box shows the right shape. */
const PLACEHOLDER: Record<string, string> = {
  openai: "sk-…",
  anthropic: "sk-ant-…",
  xai: "xai-…",
};

function reason(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : fallback;
}

/**
 * The second step of getting started: a key for the model that reads the
 * diffs, and then the model.
 *
 * The model is not typed in, and the default is not a promise: the key is
 * saved, the provider is asked what that key can reach, and the answer is
 * the list. That makes the list current without anyone shipping a release
 * to chase model names, and a provider that answers at all has proved the
 * key works — which nothing else checked.
 */
export function ModelKeyScreen({ status, onDone }: { status: ModelStatus; onDone: () => Promise<void> }): JSX.Element {
  const [provider, setProvider] = useState<ProviderInfo>(
    () => status.providers.find((p) => p.id === status.provider) ?? status.providers[0]!,
  );
  const [key, setKey] = useState("");
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const api = typeof window === "undefined" ? undefined : window.electronAPI;

  const saveKey = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!api) return;
    setBusy(true);
    setNote(null);
    try {
      const saved = await api.settings.set({ [provider.field]: key.trim() });
      if (!saved.success) throw new Error(saved.error ?? "could not save the key");
      const listed = await api.app.models(provider.id);
      if (!listed.success || !listed.data) throw new Error(listed.error ?? "could not ask what that key can reach");
      setModels(listed.data);
    } catch (error) {
      setNote({ text: reason(error, "could not save the key"), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const choose = async (id: string): Promise<void> => {
    if (!api) return;
    setBusy(true);
    setNote(null);
    try {
      const saved = await api.settings.set({ model: id });
      if (!saved.success) throw new Error(saved.error ?? "could not save the model");
      await onDone();
    } catch (error) {
      setNote({ text: reason(error, "could not save the model"), bad: true });
      setBusy(false);
    }
  };

  if (models) {
    return (
      <FirstRun
        label="Choose a model"
        title="Which model should read your diffs?"
        note={note}
        foot={`What your ${provider.label} key can reach, newest first.`}
      >
        <div className={styles.models} role="group" aria-label="Models">
          {models.map((model) => (
            <button
              key={model.id}
              className={styles.model}
              type="button"
              aria-pressed={model.id === status.model}
              disabled={busy}
              onClick={() => void choose(model.id)}
            >
              <span>{model.label}</span>
              {model.label !== model.id && <span className={styles.modelId}>{model.id}</span>}
            </button>
          ))}
        </div>
      </FirstRun>
    );
  }

  return (
    <FirstRun
      label="Add a model key"
      title="Add your key"
      note={note}
      foot="Stored encrypted by the OS keychain. You can edit your keys later."
    >
      {status.providers.length > 1 && (
        <Segmented
          label="Provider"
          options={status.providers.map((p) => ({ id: p.id, label: p.label }))}
          value={provider.id}
          disabled={busy}
          onChange={(id) => {
            const picked = status.providers.find((p) => p.id === id);
            if (!picked) return;
            setProvider(picked);
            setNote(null);
          }}
        />
      )}
      <form className={styles.form} aria-label="Model key" onSubmit={(e) => void saveKey(e)}>
        <input
          className={styles.input}
          type="password"
          aria-label={`${provider.label} API key`}
          placeholder={PLACEHOLDER[provider.id] ?? ""}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <Button className={styles.continue} type="submit" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Continue"}
        </Button>
      </form>
    </FirstRun>
  );
}
