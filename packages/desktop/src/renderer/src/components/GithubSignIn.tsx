import { SiGithub } from "@icons-pack/react-simple-icons";
import { useCallback, useEffect, useState, type FormEvent, type JSX } from "react";
import type { DevicePrompt, ElectronAPI, GithubIdentity } from "../../../types/electronAPI.js";
import { Button } from "./Button.js";
import styles from "./GithubSignIn.module.css";

const OAUTH_APPS_URL = "https://github.com/settings/developers";

interface Note {
  text: string;
  bad: boolean;
}

function reason(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : fallback;
}

/**
 * The GitHub half of the settings page: who the app is signed in as, or
 * the ways to sign it in.
 *
 * The Device Flow is the way built for an app with no browser of its own —
 * GitHub gives a short code, the reader types it into their browser, and
 * the main process, polling, is handed a token. It wants an OAuth App's
 * client id, which is public. The GitHub CLI is the shortcut: if `gh` is
 * signed in here, its token already works and costs one click. Pasting a
 * token by hand is still there, folded away.
 */
export function GithubSignIn({ api, onChange }: { api: ElectronAPI; onChange?: (identity: GithubIdentity | null) => void }): JSX.Element {
  const [identity, setIdentity] = useState<GithubIdentity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [device, setDevice] = useState<DevicePrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [cli, setCli] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");

  const settle = useCallback(
    (next: GithubIdentity | null): void => {
      setIdentity(next);
      setDevice(null);
      setBusy(false);
      onChange?.(next);
    },
    [onChange],
  );

  useEffect(() => {
    let alive = true;
    void api.auth
      .identity()
      .then((result) => {
        if (!alive) return;
        if (result.success) setIdentity(result.data ?? null);
        // A stored token GitHub has stopped taking reads as a sign-out with a reason.
        else setNote({ text: result.error ?? "could not ask GitHub who you are", bad: true });
      })
      .catch((error: unknown) => {
        if (alive) setNote({ text: reason(error, "could not ask GitHub who you are"), bad: true });
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    void api.auth.cliAvailable().then((result) => {
      if (alive && result.success) setCli(Boolean(result.data));
    });
    void api.settings.get().then((result) => {
      if (alive && result.success && result.data) setClientId(result.data.githubClientId);
    });
    // The token lands in the main process, long after the click that asked for it.
    const stop = api.auth.onChanged((next) => {
      if (!alive) return;
      if (next) setNote({ text: `signed in as ${next.login}`, bad: false });
      settle(next);
    });
    return () => {
      alive = false;
      stop();
    };
  }, [api, settle]);

  const signIn = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api.auth.signIn();
      if (result.success && result.data) setDevice(result.data);
      else {
        setNote({ text: result.error ?? "could not start signing in", bad: true });
        setBusy(false);
      }
    } catch (error) {
      setNote({ text: reason(error, "could not start signing in"), bad: true });
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    await api.auth.cancel();
    setDevice(null);
    setBusy(false);
  };

  const useCli = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api.auth.useCli();
      if (result.success && result.data) {
        setNote({ text: `signed in as ${result.data.login}`, bad: false });
        settle(result.data);
      } else {
        setNote({ text: result.error ?? "could not take the CLI's token", bad: true });
        setBusy(false);
      }
    } catch (error) {
      setNote({ text: reason(error, "could not take the CLI's token"), bad: true });
      setBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    setBusy(true);
    const result = await api.auth.signOut();
    setNote(result.success ? null : { text: result.error ?? "could not sign out", bad: true });
    settle(null);
  };

  /** The client id and a pasted token are settings like any other; keep the rest as it is. */
  const saveField = async (e: FormEvent, field: "githubClientId" | "githubToken", value: string): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const current = await api.settings.get();
      if (!current.success || !current.data) throw new Error(current.error ?? "could not read the settings");
      const result = await api.settings.set({ ...current.data, [field]: value });
      if (!result.success) throw new Error(result.error ?? "could not save");
      setNote({ text: "saved", bad: false });
      if (field === "githubToken" && value) {
        const who = await api.auth.identity();
        if (who.success) settle(who.data ?? null);
      }
    } catch (error) {
      setNote({ text: reason(error, "could not save"), bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-label="GitHub">
      <div className={styles.label}>GitHub</div>
      {identity ? (
        <div className={styles.row}>
          {identity.avatarUrl ? (
            <img className={styles.avatar} src={identity.avatarUrl} alt="" width={38} height={38} />
          ) : (
            <span className={styles.avatarMark} aria-hidden="true">
              <SiGithub />
            </span>
          )}
          <div className={styles.who}>
            <div className={styles.login}>{identity.login}</div>
            <div className={styles.sub}>{identity.scopes.length ? `signed in · ${identity.scopes.join(", ")}` : "signed in"}</div>
          </div>
          <span className={styles.spacer} />
          <Button size="sm" disabled={busy} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      ) : device ? (
        <div className={styles.device}>
          <span className={styles.code}>{device.userCode}</span>
          <span className={styles.deviceText}>
            Type this at <strong>{device.verificationUri.replace(/^https?:\/\//, "")}</strong>, which is open in your browser.
          </span>
          <span className={styles.spacer} />
          <span className={styles.waiting}>
            <span className={styles.pulse} aria-hidden="true" />
            Waiting
          </span>
          <Button size="sm" onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <div className={styles.blurb}>
            Deep Review reads the PRs waiting on you and their diffs. Signing in with GitHub asks for the <code>repo</code> and{" "}
            <code>read:org</code> scopes, and the token is kept encrypted by the OS keychain.
          </div>
          <div className={styles.ways}>
            <Button variant="primary" disabled={busy || !loaded} onClick={() => void signIn()}>
              <SiGithub aria-hidden="true" />
              Sign in with GitHub
            </Button>
            {cli && (
              <Button disabled={busy} onClick={() => void useCli()} title="Take the token the GitHub CLI is signed in with">
                <SiGithub aria-hidden="true" />
                Use the GitHub CLI token
              </Button>
            )}
          </div>
        </>
      )}
      {note && (
        <div className={styles.note} data-bad={note.bad ? "true" : "false"}>
          {note.text}
        </div>
      )}
      {!identity && (
        <details className={styles.more}>
          <summary>Other ways in</summary>
          <div className={styles.moreBody}>
            <form className={styles.field} aria-label="OAuth client id" onSubmit={(e) => void saveField(e, "githubClientId", clientId)}>
              <label className={styles.fieldLabel} htmlFor="github-client-id">
                OAuth client id
              </label>
              <input
                className={styles.input}
                id="github-client-id"
                type="text"
                value={clientId}
                autoComplete="off"
                spellCheck={false}
                placeholder="Iv1.0123456789abcdef"
                onChange={(e) => setClientId(e.target.value)}
              />
              <Button size="sm" type="submit" disabled={busy}>
                Save
              </Button>
              <div className={styles.hint}>
                Signing in with GitHub needs an OAuth App of your own with Device Flow enabled. It has no secret.{" "}
                <button className={styles.link} type="button" onClick={() => void api.app.openExternal(OAUTH_APPS_URL)}>
                  Register one on GitHub
                </button>
              </div>
            </form>
            <form className={styles.field} aria-label="Paste a token" onSubmit={(e) => void saveField(e, "githubToken", token)}>
              <label className={styles.fieldLabel} htmlFor="github-token">
                Paste a token
              </label>
              <input
                className={styles.input}
                id="github-token"
                type="password"
                value={token}
                autoComplete="off"
                spellCheck={false}
                placeholder="ghp_…"
                onChange={(e) => setToken(e.target.value)}
              />
              <Button size="sm" type="submit" disabled={busy || !token}>
                Save
              </Button>
              <div className={styles.hint}>A classic token with repo scope works the same as signing in.</div>
            </form>
          </div>
        </details>
      )}
    </section>
  );
}
