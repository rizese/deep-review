import { SiGithub } from "@icons-pack/react-simple-icons";
import type { JSX } from "react";
import { useGithubAuth } from "../lib/useGithubAuth.js";
import { Button } from "./Button.js";
import { DeviceCode } from "./DeviceCode.js";
import styles from "./GithubSignIn.module.css";

/**
 * The GitHub half of the settings page: who the app is signed in as, or
 * the two ways to sign it in — the same two the sign-in screen offers.
 */
export function GithubSignIn(): JSX.Element {
  const auth = useGithubAuth();
  const note = auth.note;
  const busy = auth.busy;

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
    </section>
  );
}
