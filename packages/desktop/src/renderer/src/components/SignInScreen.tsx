import { SiGithub } from "@icons-pack/react-simple-icons";
import { useState, type JSX } from "react";
import { useGithubAuth } from "../lib/useGithubAuth.js";
import { Button } from "./Button.js";
import { DeviceCode } from "./DeviceCode.js";
import { TokenPaste } from "./TokenPaste.js";
import styles from "./SignInScreen.module.css";

/**
 * What the index is before there is a token: not an empty list with a
 * banner over it, but the one thing there is to do, in the middle of the
 * window. Signing in happens here — the button starts the device flow
 * rather than sending anyone to a settings page to find it.
 *
 * Signing in with GitHub is one step: the code appears where you stand.
 * The CLI token is two, because the token has to be fetched in a terminal
 * first; asking for it only once that way has been chosen keeps the
 * choice itself down to two buttons.
 */
export function SignInScreen(): JSX.Element {
  const auth = useGithubAuth();
  const [pasting, setPasting] = useState(false);

  return (
    <main className={styles.screen} aria-label="Sign in">
      <span className={styles.mark} aria-hidden="true">
        <SiGithub />
      </span>
      <h1 className={styles.title}>Sign in to GitHub</h1>
      {auth.device ? (
        <DeviceCode
          prompt={auth.device}
          wide
          onCancel={() => void auth.cancel()}
        />
      ) : pasting ? (
        <TokenPaste
          onSubmit={auth.signInWithToken}
          onBack={() => setPasting(false)}
          busy={auth.busy}
        />
      ) : (
        <>
          <div className={styles.ways}>
            <Button
              disabled={auth.busy || !auth.loaded}
              onClick={() => void auth.signIn()}
            >
              <SiGithub aria-hidden="true" />
              Sign in with GitHub
            </Button>
            <Button
              disabled={auth.busy}
              onClick={() => setPasting(true)}
              title="Paste the token the GitHub CLI is signed in with"
            >
              <SiGithub aria-hidden="true" />
              Use the GitHub CLI token
            </Button>
          </div>
          <p className={styles.scopes}>
            Asks for <code>repo</code> and <code>read:org</code>, and keeps the
            token encrypted by the OS keychain.
          </p>
        </>
      )}
      {auth.note && (
        <div
          className={styles.note}
          data-bad={auth.note.bad ? "true" : "false"}
        >
          {auth.note.text}
        </div>
      )}
    </main>
  );
}
