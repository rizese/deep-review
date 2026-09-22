import { Sparkles } from "lucide-react";
import { useState, type FormEvent, type JSX } from "react";
import type { ModelStatus } from "../../../types/electronAPI.js";
import { Button } from "./Button.js";
import { FirstRun, type Note } from "./FirstRun.js";
import styles from "./ModelKeyScreen.module.css";

/** The settings field a given environment variable is stored in. */
const FIELD: Record<string, "openaiApiKey" | "anthropicApiKey" | "grokApiKey"> = {
  OPENAI_API_KEY: "openaiApiKey",
  ANTHROPIC_API_KEY: "anthropicApiKey",
  XAI_API_KEY: "grokApiKey",
  GROK_API_KEY: "grokApiKey",
};

const PROVIDER: Record<string, string> = {
  OPENAI_API_KEY: "OpenAI",
  ANTHROPIC_API_KEY: "Anthropic",
  XAI_API_KEY: "xAI",
  GROK_API_KEY: "xAI",
};

function reason(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : fallback;
}

/**
 * The second step of getting started: a key for the model that reads the
 * diffs.
 *
 * Which key depends on the model, and the model is a setting, so the step
 * asks for whichever one the current model wants and lets that model be
 * changed here — otherwise someone holding an Anthropic key would be
 * looking at a box asking for an OpenAI one with no way out.
 */
export function ModelKeyScreen({ status, onDone }: { status: ModelStatus; onDone: () => Promise<void> }): JSX.Element {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(status.model);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const wanted = status.envVars[0] ?? "OPENAI_API_KEY";
  const provider = PROVIDER[wanted] ?? "the model's";
  const field = FIELD[wanted] ?? "openaiApiKey";

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const result = await window.electronAPI?.settings.set({ [field]: key.trim(), model: model.trim() });
      if (result && !result.success) throw new Error(result.error ?? "could not save");
      await onDone();
    } catch (error) {
      setNote({ text: reason(error, "could not save"), bad: true });
    } finally {
      setBusy(false);
    }
  };

  // Changing the model changes which key is wanted, so it is saved on its
  // own and the step comes back asking for the other one.
  const useModel = async (): Promise<void> => {
    if (model.trim() === status.model) return;
    setBusy(true);
    setNote(null);
    try {
      await window.electronAPI?.settings.set({ model: model.trim() });
      await onDone();
    } catch (error) {
      setNote({ text: reason(error, "could not save"), bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FirstRun
      label="Add a model key"
      mark={<Sparkles />}
      title={`Add your ${provider} key`}
      note={note}
      blurb={
        <>
          Deep Review reads each diff with a model to cut it into slices. <code>{status.model}</code> does that here, and it needs a key.
        </>
      }
      foot={
        <>
          Stored encrypted by the OS keychain, and read as <code>{wanted}</code>.
        </>
      }
    >
      <form className={styles.form} aria-label="Model key" onSubmit={(e) => void save(e)}>
        <input
          className={styles.input}
          type="password"
          aria-label={`${provider} API key`}
          placeholder="sk-…"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <Button type="submit" disabled={busy || !key.trim()}>
          Save
        </Button>
      </form>
      <div className={styles.other}>
        <label className={styles.otherLabel} htmlFor="first-run-model">
          Model
        </label>
        <input
          className={styles.model}
          id="first-run-model"
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => void useModel()}
        />
      </div>
    </FirstRun>
  );
}
