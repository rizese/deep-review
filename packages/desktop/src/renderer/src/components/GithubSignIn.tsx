import { SiGithub } from "@icons-pack/react-simple-icons";
import { useEffect, useState, type FormEvent, type JSX } from "react";
import type { ElectronAPI } from "../../../types/electronAPI.js";
import { useGithubAuth } from "../lib/useGithubAuth.js";
import { Button } from "./Button.js";
import { DeviceCode } from "./DeviceCode.js";
import styles from "./GithubSignIn.module.css";

const OAUTH_APPS_URL = "https://github.com/settings/developers";

function reason(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : fallback;
}

/**
 * The GitHub half of the settings page: who the app is signed in as, or
 * the ways to sign it in. The same ways the sign-in screen offers, plus
 * the ones worth folding away — a client id for somebody else's OAuth
 * App, and a token pasted by hand.
 */
export function GithubSignIn({ api }: { api: ElectronAPI }): JSX.Element {
  const auth = useGithubAuth();
  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState<{ text: string; bad: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.settings.get().then((result) => {
      if (alive && result.success && result.data) setClientId(result.data.githubClientId);
    });
    return () => {
      alive = false;
    };
  }, [api]);

  /** The client id and a pasted token are settings like any other; keep the rest as it is. */
  const saveField = async (e: FormEvent, field: "githubClientId" | "githubToken", value: string): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setSaved(null);
    try {
      const current = await api.settings.get();
      if (!current.success || !current.data) throw new Error(current.error ?? "could not read the settings");
      const result = await api.settings.set({ ...current.data, [field]: value });
      if (!result.success) throw new Error(result.error ?? "could not save");
      setSaved({ text: "saved", bad: false });
      if (field === "githubToken" && value) await auth.refresh();
    } catch (error) {
      setSaved({ text: reason(error, "could not save"), bad: true });
    } finally {
      setSaving(false);
    }
  };

  const note = saved ?? auth.note;
  const busy = saving || auth.busy;

  return (
    <section className={styles.card} aria-label="GitHub">
      <div className={styles.label}>GitHub</div>
      {auth.identity ? (
        <div className={styles.row}>
          {auth.identity.avatarUrl ? (
            <img className={styles.avatar} src={auth.identity.avatarUrl} alt="" width={38} height={38} />
          ) : (
            <span className={styles.avatarMark} aria-hidden="true">
              <SiGithub />
            </span>
          )}
          <div className={styles.who}>
            <div className={styles.login}>{auth.identity.login}</div>
            <div className={styles.sub}>{auth.identity.scopes.length ? `signed in · ${auth.identity.scopes.join(", ")}` : "signed in"}</div>
          </div>
          <span className={styles.spacer} />
          <Button size="sm" disabled={busy} onClick={() => void auth.signOut()}>
            Sign out
          </Button>
        </div>
      ) : auth.device ? (
        <DeviceCode prompt={auth.device} onCancel={() => void auth.cancel()} />
      ) : (
        <>
          <div className={styles.blurb}>
            Deep Review reads the PRs waiting on you and their diffs. Signing in with GitHub asks for the <code>repo</code> and{" "}
            <code>read:org</code> scopes, and the token is kept encrypted by the OS keychain.
          </div>
          <div className={styles.ways}>
            <Button disabled={busy || !auth.loaded} onClick={() => void auth.signIn()}>
              <SiGithub aria-hidden="true" />
              Sign in with GitHub
            </Button>
            {auth.cli && (
              <Button disabled={busy} onClick={() => void auth.useCli()} title="Take the token the GitHub CLI is signed in with">
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
      {!auth.identity && (
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
                placeholder="Ov23li…"
                onChange={(e) => setClientId(e.target.value)}
              />
              <Button size="sm" type="submit" disabled={busy}>
                Save
              </Button>
              <div className={styles.hint}>
                Paste a client id to sign in against your own OAuth App rather than the one this build was made with. It needs Device Flow
                enabled, and has no secret.{" "}
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
