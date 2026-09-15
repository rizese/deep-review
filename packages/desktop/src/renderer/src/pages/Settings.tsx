import { useCallback, useEffect, useState, type FormEvent, type JSX } from "react";
import type { ElectronAPI, Settings as SettingsValues, WatchedRepoEntry } from "../../../types/electronAPI.js";
import { Chrome } from "../components/Chrome.js";
import { usePrs } from "../lib/usePrs.js";
import styles from "./Settings.module.css";

const TOKENS_URL = "https://github.com/settings/tokens";

interface KeyField {
  id: "githubToken" | "openaiApiKey" | "anthropicApiKey" | "grokApiKey" | "linearApiKey";
  label: string;
  hint: string;
}

const KEY_FIELDS: KeyField[] = [
  { id: "githubToken", label: "GitHub token", hint: "Finds your PRs and reads their diffs; a classic token with repo scope." },
  { id: "openaiApiKey", label: "OpenAI key", hint: "For slicing with an OpenAI model." },
  { id: "anthropicApiKey", label: "Anthropic key", hint: "For slicing with a Claude model." },
  { id: "grokApiKey", label: "Grok key", hint: "For slicing with a Grok model." },
  { id: "linearApiKey", label: "Linear key", hint: "Reads the issue a PR names, when it names one." },
];

const EMPTY: SettingsValues = {
  githubToken: "",
  openaiApiKey: "",
  anthropicApiKey: "",
  grokApiKey: "",
  linearApiKey: "",
  model: "",
  openAtLogin: false,
};

/** `owner/repo`, the only shape the watcher takes. */
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

interface Note {
  text: string;
  bad: boolean;
}

function reason(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : fallback;
}

function when(at: number | null): string {
  if (at === null) return "not yet";
  const ago = Math.max(0, Date.now() - at);
  const minutes = Math.round(ago / 60_000);
  const since = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
  return `${new Date(at).toLocaleTimeString()} · ${since}`;
}

/** The keys the server and the slicer need, kept by the app rather than the environment. */
function Keys({ api }: { api: ElectronAPI }): JSX.Element {
  const [values, setValues] = useState<SettingsValues>(EMPTY);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    let alive = true;
    void api.settings
      .get()
      .then((result) => {
        if (!alive) return;
        if (result.success && result.data) setValues(result.data);
        else setNote({ text: result.error ?? "could not read the settings", bad: true });
      })
      .catch((error: unknown) => {
        if (alive) setNote({ text: reason(error, "could not read the settings"), bad: true });
      });
    return () => {
      alive = false;
    };
  }, [api]);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const result = await api.settings.set(values);
      setNote(result.success ? { text: "saved", bad: false } : { text: result.error ?? "could not save", bad: true });
    } catch (error) {
      setNote({ text: reason(error, "could not save"), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const edit = (id: keyof SettingsValues, value: string | boolean): void => {
    setValues((prev) => ({ ...prev, [id]: value }));
    setNote(null);
  };

  return (
    <form className={styles.card} aria-label="Keys" onSubmit={(e) => void save(e)}>
      <div className={styles.label}>Keys</div>
      <div className={styles.fields}>
        {KEY_FIELDS.map((field) => (
          <div className={styles.field} key={field.id}>
            <label className={styles.fieldLabel} htmlFor={`setting-${field.id}`}>
              {field.label}
            </label>
            <div className={styles.control}>
              <input
                className={`${styles.input} ${styles.secret}`}
                id={`setting-${field.id}`}
                type={shown[field.id] ? "text" : "password"}
                value={values[field.id]}
                autoComplete="off"
                spellCheck={false}
                placeholder="not set"
                onChange={(e) => edit(field.id, e.target.value)}
              />
              <button
                className={styles.ghost}
                type="button"
                aria-pressed={shown[field.id] ?? false}
                aria-label={`${shown[field.id] ? "Hide" : "Show"} the ${field.label.toLowerCase()}`}
                onClick={() => setShown((prev) => ({ ...prev, [field.id]: !prev[field.id] }))}
              >
                {shown[field.id] ? "hide" : "show"}
              </button>
            </div>
            <div className={styles.hint}>
              {field.hint}
              {field.id === "githubToken" && (
                <>
                  {" "}
                  <button className={styles.link} type="button" onClick={() => void api.app.openExternal(TOKENS_URL)}>
                    Make one on GitHub
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="setting-model">
            Model
          </label>
          <div className={styles.control}>
            <input
              className={styles.input}
              id="setting-model"
              type="text"
              value={values.model}
              autoComplete="off"
              spellCheck={false}
              placeholder="default"
              onChange={(e) => edit("model", e.target.value)}
            />
          </div>
          <div className={styles.hint}>The model id the slicer runs on; empty leaves the CLI's default in place.</div>
        </div>
        <div className={styles.field}>
          <label className={styles.check}>
            <input type="checkbox" checked={values.openAtLogin} onChange={(e) => edit("openAtLogin", e.target.checked)} /> Open at login
          </label>
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.button} type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {note && <span className={`${styles.note} ${note.bad ? styles.bad : styles.ok}`}>{note.text}</span>}
      </div>
    </form>
  );
}

/** The repos the watcher polls, and a way to make it poll now. */
function Repos({ api }: { api: ElectronAPI }): JSX.Element {
  const [repos, setRepos] = useState<WatchedRepoEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await api.watch.list();
      if (result.success && result.data) setRepos(result.data);
      else setNote({ text: result.error ?? "could not read the watch list", bad: true });
    } catch (error) {
      setNote({ text: reason(error, "could not read the watch list"), bad: true });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const repo = draft.trim();
    if (!REPO.test(repo)) {
      setNote({ text: "name a repo as owner/repo", bad: true });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const result = await api.watch.add(repo);
      if (result.success) {
        setDraft("");
        await load();
      } else setNote({ text: result.error ?? "could not watch that repo", bad: true });
    } catch (error) {
      setNote({ text: reason(error, "could not watch that repo"), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (repo: string): Promise<void> => {
    setNote(null);
    try {
      const result = await api.watch.remove(repo);
      if (result.success) await load();
      else setNote({ text: result.error ?? "could not stop watching that repo", bad: true });
    } catch (error) {
      setNote({ text: reason(error, "could not stop watching that repo"), bad: true });
    }
  };

  const pollNow = async (): Promise<void> => {
    setPolling(true);
    setNote(null);
    try {
      const result = await api.watch.pollNow();
      setNote(result.success ? { text: "checked", bad: false } : { text: result.error ?? "the check failed", bad: true });
    } catch (error) {
      setNote({ text: reason(error, "the check failed"), bad: true });
    } finally {
      setPolling(false);
    }
  };

  return (
    <section className={styles.card} aria-label="Watched repos">
      <div className={styles.label}>Watched repos</div>
      {repos.length > 0 ? (
        <div className={styles.repos}>
          {repos.map((entry) => (
            <div className={styles.repo} key={entry.repo}>
              <div>
                <div className={styles.repoName}>{entry.repo}</div>
                {entry.query && <div className={styles.query}>for review: {entry.query}</div>}
                {entry.authoredQuery && <div className={styles.query}>authored: {entry.authoredQuery}</div>}
              </div>
              <button
                className={styles.danger}
                type="button"
                aria-label={`Stop watching ${entry.repo}`}
                onClick={() => void remove(entry.repo)}
              >
                remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.none}>No repos watched yet; the PRs here are the ones added by hand.</div>
      )}
      <form className={styles.add} aria-label="Watch a repo" onSubmit={(e) => void add(e)}>
        <input
          className={styles.input}
          type="text"
          aria-label="Repo to watch"
          placeholder="owner/repo"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setNote(null);
          }}
        />
        <button className={styles.button} type="submit" disabled={busy}>
          Add
        </button>
        <button className={styles.ghost} type="button" disabled={polling} onClick={() => void pollNow()}>
          {polling ? "Checking…" : "Check GitHub now"}
        </button>
        {note && <span className={`${styles.note} ${note.bad ? styles.bad : styles.ok}`}>{note.text}</span>}
      </form>
    </section>
  );
}

type ServerInfo = { url: string; stateDir: string; watching: boolean; lastPollAt: number | null };

/** What this app is and where it keeps what it holds. */
function About({ api }: { api: ElectronAPI }): JSX.Element {
  const [version, setVersion] = useState("");
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    let alive = true;
    void api.app.version().then((v) => {
      if (alive) setVersion(v);
    });
    void api.app
      .serverInfo()
      .then((result) => {
        if (!alive) return;
        if (result.success && result.data) setInfo(result.data);
        else setNote({ text: result.error ?? "the server is not answering", bad: true });
      })
      .catch((error: unknown) => {
        if (alive) setNote({ text: reason(error, "the server is not answering"), bad: true });
      });
    return () => {
      alive = false;
    };
  }, [api]);

  return (
    <section className={styles.card} aria-label="About">
      <div className={styles.label}>About</div>
      <div className={styles.about}>
        <div className={styles.aboutKey}>Version</div>
        <div className={styles.aboutValue}>{version || "…"}</div>
        <div className={styles.aboutKey}>Server</div>
        <div className={styles.aboutValue}>
          {info ? (
            <button className={styles.link} type="button" onClick={() => void api.app.openExternal(info.url)}>
              {info.url}
            </button>
          ) : (
            "…"
          )}
        </div>
        <div className={styles.aboutKey}>State directory</div>
        <div className={styles.aboutValue}>{info?.stateDir ?? "…"}</div>
        <div className={styles.aboutKey}>Watcher</div>
        <div className={styles.aboutValue}>{info ? (info.watching ? "on" : "off") : "…"}</div>
        <div className={styles.aboutKey}>Last checked</div>
        <div className={styles.aboutValue}>{info ? when(info.lastPollAt) : "…"}</div>
      </div>
      {note && <div className={`${styles.note} ${styles.bad}`}>{note.text}</div>}
    </section>
  );
}

/** What the page says when it is being read in a plain browser. */
function NoBridge(): JSX.Element {
  return (
    <div className={styles.intro}>
      <p>These settings belong to the desktop app, which is where the keys are kept — encrypted by the OS keychain rather than by this page.</p>
      <p>
        Served from a terminal by <code>pr-review serve</code>, the same keys come from the environment: <code>GITHUB_TOKEN</code>,{" "}
        <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, <code>GROK_API_KEY</code> and <code>LINEAR_API_KEY</code>, exported in the
        shell or written into a <code>.env</code> file beside the checkout. Repos are watched with <code>pr-review watch --repo owner/repo</code>.
      </p>
    </div>
  );
}

/** The settings page: the app's keys, the repos it watches, and what it is. */
export function Settings(): JSX.Element {
  const { prs } = usePrs();
  const api = typeof window === "undefined" ? undefined : window.electronAPI;
  return (
    <>
      <Chrome count={prs.length} />
      <main className={styles.page}>
        {api ? (
          <>
            <Keys api={api} />
            <Repos api={api} />
            <About api={api} />
          </>
        ) : (
          <NoBridge />
        )}
      </main>
    </>
  );
}
