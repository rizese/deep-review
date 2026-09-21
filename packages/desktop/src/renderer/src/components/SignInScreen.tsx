import { SiGithub } from "@icons-pack/react-simple-icons";
import type { JSX } from "react";
import { go } from "../lib/route.js";
import { useGithubAuth } from "../lib/useGithubAuth.js";
import { Button } from "./Button.js";
import { DeviceCode } from "./DeviceCode.js";
import styles from "./SignInScreen.module.css";

/**
 * What the index is before there is a token: not an empty list with a
 * banner over it, but the one thing there is to do, in the middle of the
 * window. Signing in happens here — the button starts the device flow
 * rather than sending anyone to a settings page to find it.
 */
export function SignInScreen(): JSX.Element {
  const auth = useGithubAuth();

  return (
    <main className={styles.screen} aria-label="Sign in">
      <span className={styles.mark} aria-hidden="true">
        <SiGithub />
      </span>
      <h1 className={styles.title}>Sign in to GitHub</h1>
      <p className={styles.blurb}>
        Deep Review finds the pull requests waiting on your review and builds a reading of each one: the diff cut into slices, with a call
        graph you can walk.
      </p>
      {auth.device ? (
        <DeviceCode prompt={auth.device} wide onCancel={() => void auth.cancel()} />
      ) : (
        <>
          <div className={styles.ways}>
            <Button disabled={auth.busy || !auth.loaded} onClick={() => void auth.signIn()}>
              <SiGithub aria-hidden="true" />
              Sign in with GitHub
            </Button>
            {auth.cli && (
              <Button disabled={auth.busy} onClick={() => void auth.useCli()} title="Take the token the GitHub CLI is signed in with">
                <SiGithub aria-hidden="true" />
                Use the GitHub CLI token
              </Button>
            )}
          </div>
          <p className={styles.scopes}>
            Asks for <code>repo</code> and <code>read:org</code>, and keeps the token encrypted by the OS keychain.
          </p>
        </>
      )}
      {auth.note && (
        <div className={styles.note} data-bad={auth.note.bad ? "true" : "false"}>
          {auth.note.text}
        </div>
      )}
      <button className={styles.settings} type="button" onClick={() => go("/settings")}>
        Other ways in
      </button>
    </main>
  );
}
